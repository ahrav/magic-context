import { describe, expect, it } from "bun:test";
import {
    TODO_PARITY_MATRIX,
    compareDeclaredParitySetup,
    normalizeTodoSyntheticInjection,
    preconditionTodoDeferReplay,
    preconditionTodoSyntheticInjection,
    verifyTodoDeferReplay,
    verifyTodoSyntheticInjection,
    type DependentTodoObservation,
    type Todo1Observation,
    type TodoParitySetup,
} from "./parity-synthetic-todo";

function failedIds(checks: Array<{ id: string; passed: boolean }>): string[] {
    return checks.filter((check) => !check.passed).map((check) => check.id);
}

const SETUP: TodoParitySetup = {
    promptMatched: true,
    toolRegistryMatched: true,
    environmentMatched: true,
    clonedStateMatched: true,
    modeMatched: true,
    harnessMatched: true,
    prerequisitesMet: true,
};

function todo1(
    overrides: Partial<Todo1Observation> = {},
): Todo1Observation {
    return {
        kind: "rust-todo-1-synthetic-injection",
        ...SETUP,
        todoWriteExecuted: true,
        schemaAccepted: true,
        pressureUsedRealBytes: true,
        providerRequestCaptured: true,
        moduleTodoStateCaptured: true,
        providerSyntheticPairPresent: false,
        deterministicCallIdMatched: false,
        ...overrides,
    };
}

function dependent(
    overrides: Partial<DependentTodoObservation> = {},
): DependentTodoObservation {
    return {
        kind: "rust-todo-2-defer-replay",
        ...SETUP,
        rootTodoWriteExecuted: true,
        rootModuleStateCaptured: true,
        rootSyntheticPairPresent: true,
        ownActionExecuted: true,
        providerTransitionCorrect: true,
        durableTransitionCorrect: true,
        ...overrides,
    };
}

describe("Rust synthetic todo incident family", () => {
    it("declares the complete interface parity matrix", () => {
        expect(TODO_PARITY_MATRIX.map((row) => row.interface)).toEqual([
            "opencode-ts",
            "opencode-rust",
            "pi-ts",
        ]);
        for (const row of TODO_PARITY_MATRIX) {
            expect(row.toolAvailability).toBe("todowrite");
            expect(row.schema).toBe("todos-content-status-priority");
            expect(row.actionSequence).toEqual([
                "capture",
                "pressure",
                "bust",
                "defer",
                "terminal",
            ]);
            expect(row.providerResult).toBe("synthetic-tool-pair");
            expect(row.durableTransition).toBe(
                "captured-frozen-replayed-cleared",
            );
            expect(row.prerequisites.length).toBeGreaterThan(0);
        }
    });

    it("compares only declared normalized setup fields", () => {
        expect(compareDeclaredParitySetup(SETUP, SETUP)).toBe(true);
        for (const field of [
            "promptMatched",
            "toolRegistryMatched",
            "environmentMatched",
            "clonedStateMatched",
            "modeMatched",
            "harnessMatched",
            "prerequisitesMet",
        ] as const) {
            expect(
                compareDeclaredParitySetup(SETUP, {
                    ...SETUP,
                    [field]: false,
                }),
            ).toBe(false);
        }
    });

    it("scores Todo 1 red only after module capture and provider observation", () => {
        const observation = todo1();
        expect(preconditionTodoSyntheticInjection(observation)).toEqual({
            satisfied: true,
        });
        expect(failedIds(verifyTodoSyntheticInjection(observation))).toEqual([
            "check-todo1-synthetic-pair-present",
        ]);
    });

    it("leaves no-todowrite and mismatched setup observations unscored", () => {
        expect(
            preconditionTodoSyntheticInjection(
                todo1({ todoWriteExecuted: false }),
            ),
        ).toEqual({
            satisfied: false,
            reason: "precondition_unmet",
            blockedBy: [],
        });
        expect(
            preconditionTodoSyntheticInjection(
                todo1({ environmentMatched: false }),
            ),
        ).toEqual({
            satisfied: false,
            reason: "precondition_unmet",
            blockedBy: [],
        });
    });

    it("rejects a synthetic pair with the wrong deterministic call id", () => {
        expect(
            failedIds(
                verifyTodoSyntheticInjection(
                    todo1({
                        providerSyntheticPairPresent: true,
                        deterministicCallIdMatched: false,
                    }),
                ),
            ),
        ).toEqual(["check-todo1-synthetic-pair-present"]);
    });

    it("reports Todo 2-5 as reviewed blocked when Todo 1 is absent", () => {
        for (const kind of [
            "rust-todo-2-defer-replay",
            "rust-todo-3-newer-todo-deferral",
            "rust-todo-4-legacy-anchor-heal",
            "rust-todo-5-terminal-clear",
        ] as const) {
            expect(
                preconditionTodoDeferReplay(
                    dependent({
                        kind,
                        rootSyntheticPairPresent: false,
                        ownActionExecuted: false,
                    }),
                ),
            ).toEqual({
                satisfied: false,
                reason: "blocked_by_dependency",
                blockedBy: ["var-todo-1-synthetic-injection"],
            });
        }
    });

    it("distinguishes a missing root precondition from an own-check failure", () => {
        expect(
            preconditionTodoDeferReplay(
                dependent({ prerequisitesMet: false, ownActionExecuted: false }),
            ),
        ).toEqual({
            satisfied: false,
            reason: "blocked_by_dependency",
            blockedBy: ["var-todo-1-synthetic-injection"],
        });
        const wrongDurableState = dependent({ durableTransitionCorrect: false });
        expect(preconditionTodoDeferReplay(wrongDurableState)).toEqual({
            satisfied: true,
        });
        expect(failedIds(verifyTodoDeferReplay(wrongDurableState))).toEqual([
            "check-todo2-byte-identical-replay",
        ]);
    });

    it("rejects malformed observations before verification", () => {
        expect(() =>
            normalizeTodoSyntheticInjection({
                ...todo1(),
                unexpected: true,
            }),
        ).toThrow(/must contain exactly/);
    });
});
