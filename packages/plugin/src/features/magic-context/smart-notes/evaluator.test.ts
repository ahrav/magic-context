import { describe, expect, test } from "bun:test";

import type { CompileSmartNoteResult } from "./compiler";
import { evaluateSmartNotePhase, type SmartNotePhaseExecutors } from "./evaluator";
import type { RunCompiledSmartNoteCheckResult } from "./sandbox-runner";

const SNAPSHOT = {
    noteId: 7,
    content: "note",
    surfaceCondition: "condition",
    compiledCheck: "function check() { return { met: true }; }",
};

function executors(overrides: Partial<SmartNotePhaseExecutors>): SmartNotePhaseExecutors {
    return {
        compile: () => Promise.reject(new Error("compile not expected")),
        runCompiled: () => Promise.reject(new Error("runCompiled not expected")),
        confirmFallback: () => Promise.reject(new Error("confirmFallback not expected")),
        ...overrides,
    };
}

const compiledOk: CompileSmartNoteResult = {
    ok: true,
    compiledCheck: "function check() { return { met: true }; }",
    manifest: { capabilities: [] },
    checkCron: "0 * * * *",
    checkHash: "h".repeat(64),
    dryRun: { met: true },
};

describe("evaluateSmartNotePhase compile", () => {
    test("dry-run met maps to compiled_met with the artifact", async () => {
        const result = await evaluateSmartNotePhase(
            { phase: "compile", ...SNAPSHOT },
            executors({ compile: () => Promise.resolve(compiledOk) }),
        );
        expect(result).toEqual({
            ok: true,
            outcome: {
                phase: "compile",
                kind: "compiled_met",
                artifact: {
                    compiledCheck: compiledOk.compiledCheck,
                    manifestJson: JSON.stringify(compiledOk.manifest),
                    checkHash: compiledOk.checkHash,
                    checkCron: compiledOk.checkCron,
                },
            },
        });
    });

    test("dry-run false maps to compiled_false", async () => {
        const result = await evaluateSmartNotePhase(
            { phase: "compile", ...SNAPSHOT },
            executors({
                compile: () => Promise.resolve({ ...compiledOk, dryRun: { met: false } }),
            }),
        );
        expect(result.ok && result.outcome.kind).toBe("compiled_false");
    });

    test("compilation errors map to compilation_failed", async () => {
        const result = await evaluateSmartNotePhase(
            { phase: "compile", ...SNAPSHOT },
            executors({
                compile: () => Promise.resolve({ ok: false, cancelled: false, error: "boom" }),
            }),
        );
        expect(result.ok && result.outcome.kind).toBe("compilation_failed");
    });

    test("cancellation maps to an abandonment, never an outcome", async () => {
        const result = await evaluateSmartNotePhase(
            { phase: "compile", ...SNAPSHOT },
            executors({
                compile: () => Promise.resolve({ ok: false, cancelled: true, error: "aborted" }),
            }),
        );
        expect(result).toEqual({ ok: false, abandoned: true, reason: "aborted" });
    });
});

describe("evaluateSmartNotePhase due and liveness", () => {
    const runs: Array<
        [RunCompiledSmartNoteCheckResult, "met" | "false" | "network_failed" | "logic_failed"]
    > = [
        [{ ok: true, result: { met: true } }, "met"],
        [{ ok: true, result: { met: false } }, "false"],
        [{ ok: false, cancelled: false, error: "net", network: true }, "network_failed"],
        [{ ok: false, cancelled: false, error: "logic", network: false }, "logic_failed"],
    ];

    for (const phase of ["due", "liveness"] as const) {
        for (const [run, expected] of runs) {
            test(`${phase}: ${expected}`, async () => {
                const result = await evaluateSmartNotePhase(
                    { phase, ...SNAPSHOT },
                    executors({ runCompiled: () => Promise.resolve(run) }),
                );
                expect(result.ok && result.outcome.kind).toBe(expected);
            });
        }

        test(`${phase}: cancellation abandons`, async () => {
            const result = await evaluateSmartNotePhase(
                { phase, ...SNAPSHOT },
                executors({
                    runCompiled: () =>
                        Promise.resolve({
                            ok: false,
                            cancelled: true,
                            error: "aborted",
                            network: false,
                        }),
                }),
            );
            expect(result.ok).toBe(false);
        });

        test(`${phase}: a missing compiled check is a logic failure`, async () => {
            const result = await evaluateSmartNotePhase(
                { phase, ...SNAPSHOT, compiledCheck: null },
                executors({}),
            );
            expect(result.ok && result.outcome.kind).toBe("logic_failed");
        });
    }
});

describe("evaluateSmartNotePhase fallback", () => {
    test("confirmation true maps to met", async () => {
        const result = await evaluateSmartNotePhase(
            { phase: "fallback", ...SNAPSHOT },
            executors({ confirmFallback: () => Promise.resolve(true) }),
        );
        expect(result.ok && result.outcome.kind).toBe("met");
    });

    test("confirmation false maps to false", async () => {
        const result = await evaluateSmartNotePhase(
            { phase: "fallback", ...SNAPSHOT },
            executors({ confirmFallback: () => Promise.resolve(false) }),
        );
        expect(result.ok && result.outcome.kind).toBe("false");
    });

    test("cancelled confirmation abandons", async () => {
        const result = await evaluateSmartNotePhase(
            { phase: "fallback", ...SNAPSHOT },
            executors({ confirmFallback: () => Promise.resolve(null) }),
        );
        expect(result).toEqual({
            ok: false,
            abandoned: true,
            reason: "fallback confirmation cancelled",
        });
    });
});
