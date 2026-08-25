import { describe, expect, it } from "bun:test";
import {
    normalizePiTodoAnchorLifecycle,
    preconditionPiTodoAnchorLifecycle,
    preconditionPiTodoCapture,
    preconditionPiTodoDeferReplay,
    preconditionPiTodoInjection,
    verifyPiTodoAnchorLifecycle,
    verifyPiTodoCapture,
    verifyPiTodoDeferReplay,
    verifyPiTodoInjection,
    type PiTodoAnchorObservation,
    type PiTodoCaptureObservation,
    type PiTodoInjectionObservation,
    type PiTodoReplayObservation,
} from "./parity-pi-todo";
import type { TodoParitySetup } from "./parity-synthetic-todo";

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

function capture(
    overrides: Partial<PiTodoCaptureObservation> = {},
): PiTodoCaptureObservation {
    return {
        kind: "pi-todo-capture",
        ...SETUP,
        parentToolExecuted: true,
        parentStateCaptured: true,
        missingPriorityToolExecuted: true,
        missingPriorityDefaulted: true,
        ...overrides,
    };
}

function injection(
    overrides: Partial<PiTodoInjectionObservation> = {},
): PiTodoInjectionObservation {
    return {
        kind: "pi-todo-injection",
        ...SETUP,
        todoWriteExecuted: true,
        pressureUsedRealBytes: true,
        providerRequestCaptured: true,
        syntheticPairPresent: true,
        deterministicCallIdMatched: true,
        persistedAnchorMatched: true,
        ...overrides,
    };
}

function replay(
    overrides: Partial<PiTodoReplayObservation> = {},
): PiTodoReplayObservation {
    return {
        kind: "pi-todo-replay",
        ...SETUP,
        rootTodoWriteExecuted: true,
        pressureUsedRealBytes: true,
        providerRequestCaptured: true,
        firstReplayPresent: true,
        byteIdenticalReplay: true,
        durableReplayIdentityStable: true,
        newerTodoExecuted: true,
        newerTodoDeferred: true,
        legacyAnchorExisted: true,
        legacyAnchorHealed: true,
        ...overrides,
    };
}

function anchor(
    overrides: Partial<PiTodoAnchorObservation> = {},
): PiTodoAnchorObservation {
    return {
        kind: "pi-todo-anchor-lifecycle",
        ...SETUP,
        rootTodoWriteExecuted: true,
        providerRequestCaptured: true,
        activeAnchorExisted: true,
        subagentTodoExecuted: true,
        subagentGated: true,
        terminalTodoExecuted: true,
        terminalStateCaptured: true,
        terminalPairAbsent: true,
        terminalAnchorCleared: true,
        ...overrides,
    };
}

describe("Pi synthetic todo incident family", () => {
    it("preserves capture and default-priority assertions", () => {
        expect(preconditionPiTodoCapture(capture())).toEqual({ satisfied: true });
        expect(failedIds(verifyPiTodoCapture(capture()))).toEqual([]);
        expect(
            failedIds(
                verifyPiTodoCapture(
                    capture({ missingPriorityDefaulted: false }),
                ),
            ),
        ).toEqual(["check-pi-todo-missing-priority-default"]);
    });

    it("requires real todowrite execution before scoring", () => {
        expect(
            preconditionPiTodoCapture(capture({ parentToolExecuted: false })),
        ).toEqual({
            satisfied: false,
            reason: "precondition_unmet",
            blockedBy: [],
        });
    });

    it("rejects wrong call ids and correct bytes with wrong durable linkage", () => {
        expect(preconditionPiTodoInjection(injection())).toEqual({
            satisfied: true,
        });
        expect(
            failedIds(
                verifyPiTodoInjection(
                    injection({ deterministicCallIdMatched: false }),
                ),
            ),
        ).toEqual(["check-pi-todo-synthetic-pair-injected"]);
        expect(
            failedIds(
                verifyPiTodoInjection(
                    injection({ persistedAnchorMatched: false }),
                ),
            ),
        ).toEqual(["check-pi-todo-synthetic-pair-injected"]);
    });

    it("preserves replay, newer-deferral, and legacy-heal assertions", () => {
        expect(preconditionPiTodoDeferReplay(replay())).toEqual({
            satisfied: true,
        });
        expect(failedIds(verifyPiTodoDeferReplay(replay()))).toEqual([]);
        expect(
            failedIds(
                verifyPiTodoDeferReplay(
                    replay({ durableReplayIdentityStable: false }),
                ),
            ),
        ).toEqual(["check-pi-todo-byte-identical-replay"]);
        expect(
            failedIds(
                verifyPiTodoDeferReplay(
                    replay({ newerTodoDeferred: false }),
                ),
            ),
        ).toEqual(["check-pi-todo-newer-state-deferred"]);
        expect(
            failedIds(
                verifyPiTodoDeferReplay(
                    replay({ legacyAnchorExisted: false }),
                ),
            ),
        ).toEqual(["check-pi-todo-legacy-anchor-self-heal"]);
    });

    it("preserves subagent gating and non-vacuous terminal clearing", () => {
        expect(preconditionPiTodoAnchorLifecycle(anchor())).toEqual({
            satisfied: true,
        });
        expect(failedIds(verifyPiTodoAnchorLifecycle(anchor()))).toEqual([]);
        expect(
            failedIds(
                verifyPiTodoAnchorLifecycle(
                    anchor({ activeAnchorExisted: false }),
                ),
            ),
        ).toEqual(["check-pi-todo-terminal-anchor-clear"]);
        expect(
            failedIds(
                verifyPiTodoAnchorLifecycle(anchor({ subagentGated: false })),
            ),
        ).toEqual(["check-pi-todo-subagent-gated"]);
    });

    it("rejects mismatched environment and cloned state as preconditions", () => {
        expect(
            preconditionPiTodoInjection(
                injection({ environmentMatched: false }),
            ),
        ).toEqual({
            satisfied: false,
            reason: "precondition_unmet",
            blockedBy: [],
        });
        expect(
            preconditionPiTodoInjection(
                injection({ clonedStateMatched: false }),
            ),
        ).toEqual({
            satisfied: false,
            reason: "precondition_unmet",
            blockedBy: [],
        });
    });

    it("rejects malformed Pi observations", () => {
        expect(() =>
            normalizePiTodoAnchorLifecycle({
                ...anchor(),
                extra: true,
            }),
        ).toThrow(/must contain exactly/);
    });
});
