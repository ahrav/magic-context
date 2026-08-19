import { describe, expect, test } from "bun:test";

import type { SmartNotePhaseExecutors } from "./evaluator";
import {
    type EvaluatorMethod,
    type EvaluatorWorkerTransport,
    SmartNoteEvaluatorWorker,
} from "./evaluator-worker";

interface RecordedCall {
    method: EvaluatorMethod;
    body: Record<string, unknown>;
}

function stubTransport(
    respond: (method: EvaluatorMethod, body: Record<string, unknown>) => unknown,
): { transport: EvaluatorWorkerTransport; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    return {
        calls,
        transport: {
            call({ method, body }) {
                const record = { method, body: body as Record<string, unknown> };
                calls.push(record);
                return Promise.resolve(respond(method, record.body));
            },
        },
    };
}

const REGISTER_OK = { ok: true, token: "tok-1", registration_generation: 1, expires_at: 9e15 };

function claimResponse(noteId: number, phase: string) {
    return {
        result: "claim",
        claim_id: `claim-${noteId}`,
        note_id: noteId,
        phase,
        snapshot: {
            content: "note content",
            surface_condition: "condition",
            compiled_check: "function check() { return { met: true }; }",
        },
    };
}

function passthroughExecutors(overrides: Partial<SmartNotePhaseExecutors> = {}) {
    return (): SmartNotePhaseExecutors => ({
        compile: () => Promise.reject(new Error("compile not expected")),
        runCompiled: () => Promise.resolve({ ok: true, result: { met: true } }),
        confirmFallback: () => Promise.resolve(false),
        ...overrides,
    });
}

function worker(
    transport: EvaluatorWorkerTransport,
    executors = passthroughExecutors(),
): SmartNoteEvaluatorWorker {
    return new SmartNoteEvaluatorWorker({
        transport,
        executors,
        policy: () => ({ retinaHandoff: false, wakeOwned: false }),
        log: () => {},
    });
}

describe("SmartNoteEvaluatorWorker registration", () => {
    test("registers with protocol 2.0 and unregisters with the issued token", async () => {
        const { transport, calls } = stubTransport((method) =>
            method === "note.evaluation.register" ? REGISTER_OK : { ok: true },
        );
        const w = worker(transport);
        expect(await w.register()).toBe(true);
        expect(w.registered).toBe(true);
        await w.dispose();
        expect(w.registered).toBe(false);

        const register = calls[0];
        expect(register.method).toBe("note.evaluation.register");
        expect(register.body.protocol_version).toBe("2.0");
        expect(register.body.capacity).toBe(1);
        const unregister = calls.at(-1);
        expect(unregister?.method).toBe("note.evaluation.unregister");
        expect(unregister?.body.token).toBe("tok-1");
    });

    test("a rejected registration reports unavailable", async () => {
        const { transport } = stubTransport(() => ({ ok: false, error: "protocol_unsupported" }));
        const w = worker(transport);
        expect(await w.register()).toBe(false);
        expect(w.registered).toBe(false);
    });
});

describe("SmartNoteEvaluatorWorker drain", () => {
    test("drains zero-wait work until no_work and completes claims", async () => {
        let served = 0;
        const { transport, calls } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                served += 1;
                return served <= 2 ? claimResponse(served, "due") : { result: "no_work" };
            }
            if (method === "note.evaluation.complete") return { result: "applied" };
            return { ok: true };
        });
        const w = worker(transport);
        const result = await w.drainOnce({ deadline: Date.now() + 30_000 });
        expect(result).toEqual({
            claimed: 2,
            completed: 2,
            abandoned: 0,
            surfaced: 0,
            drained: true,
        });

        const nexts = calls.filter((c) => c.method === "note.evaluation.next");
        expect(nexts).toHaveLength(3);
        for (const next of nexts) expect(next.body.wait_ms).toBe(0);
        const completes = calls.filter((c) => c.method === "note.evaluation.complete");
        expect(completes).toHaveLength(2);
        const outcome = completes[0].body.outcome as Record<string, unknown>;
        expect(outcome.phase).toBe("due");
        expect(outcome.kind).toBe("met");
        await w.dispose();
    });

    test("a cancelled execution abandons the claim without a failure outcome", async () => {
        let served = 0;
        const { transport, calls } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                served += 1;
                return served === 1 ? claimResponse(1, "due") : { result: "no_work" };
            }
            return { ok: true, result: "abandoned" };
        });
        const w = worker(
            transport,
            passthroughExecutors({
                runCompiled: () =>
                    Promise.resolve({
                        ok: false,
                        cancelled: true,
                        error: "aborted",
                        network: false,
                    }),
            }),
        );
        const result = await w.drainOnce({ deadline: Date.now() + 5_000 });
        expect(result.abandoned).toBe(1);
        expect(result.completed).toBe(0);
        expect(calls.some((c) => c.method === "note.evaluation.abandon")).toBe(true);
        expect(calls.some((c) => c.method === "note.evaluation.complete")).toBe(false);
        await w.dispose();
    });

    test("an unknown next outcome preserves the acquisition id for replay", async () => {
        let failNext = true;
        const sawAcquisitionIds: string[] = [];
        const { transport } = stubTransport((method, body) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                sawAcquisitionIds.push(String(body.acquisition_id));
                if (failNext) {
                    failNext = false;
                    throw new Error("connection reset");
                }
                return { result: "no_work" };
            }
            return { ok: true };
        });
        const w = worker(transport);
        const first = await w.drainOnce({ deadline: Date.now() + 5_000 });
        expect(first.drained).toBe(false);
        const second = await w.drainOnce({ deadline: Date.now() + 5_000 });
        expect(second.drained).toBe(true);
        expect(sawAcquisitionIds).toHaveLength(2);
        expect(sawAcquisitionIds[0]).toBe(sawAcquisitionIds[1]);
        await w.dispose();
    });

    test("wake-owned no_work stops the drain without claiming", async () => {
        const { transport } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") return { result: "no_work", wake_owned: true };
            return { ok: true };
        });
        const w = worker(transport);
        const result = await w.drainOnce({ deadline: Date.now() + 5_000 });
        expect(result).toEqual({
            claimed: 0,
            completed: 0,
            abandoned: 0,
            surfaced: 0,
            drained: true,
        });
        await w.dispose();
    });

    test("compile claims send the artifact in the completion outcome", async () => {
        let served = 0;
        const { transport, calls } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                served += 1;
                return served === 1 ? claimResponse(1, "compile") : { result: "no_work" };
            }
            if (method === "note.evaluation.complete") return { result: "applied" };
            return { ok: true };
        });
        const w = worker(
            transport,
            passthroughExecutors({
                compile: () =>
                    Promise.resolve({
                        ok: true,
                        compiledCheck: "function check() { return { met: false }; }",
                        manifest: { capabilities: [] },
                        checkCron: "0 * * * *",
                        checkHash: "h".repeat(64),
                        dryRun: { met: false },
                    }),
            }),
        );
        const result = await w.drainOnce({ deadline: Date.now() + 5_000 });
        expect(result.completed).toBe(1);
        const complete = calls.find((c) => c.method === "note.evaluation.complete");
        const outcome = complete?.body.outcome as Record<string, unknown>;
        expect(outcome.kind).toBe("compiled_false");
        const artifact = outcome.artifact as Record<string, unknown>;
        expect(artifact.compiled_check).toBe("function check() { return { met: false }; }");
        expect(artifact.check_hash).toBe("h".repeat(64));
        await w.dispose();
    });
});
