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

    test("a false fallback confirmation is not re-claimed within the same drain", async () => {
        // Fallback selection has no next-due gate, so the authority hands the
        // same still-pending note back on every poll after a false confirmation.
        const { transport, calls } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") return claimResponse(7, "fallback");
            if (method === "note.evaluation.complete")
                return { result: "applied", status: "pending" };
            if (method === "note.evaluation.abandon") return { result: "abandoned" };
            return { ok: true };
        });
        const w = worker(transport);
        const result = await w.drainOnce({ deadline: Date.now() + 30_000 });
        expect(result.claimed).toBe(2);
        expect(result.completed).toBe(1);
        expect(result.abandoned).toBe(1);
        expect(calls.filter((c) => c.method === "note.evaluation.complete")).toHaveLength(1);
        expect(calls.filter((c) => c.method === "note.evaluation.abandon")).toHaveLength(1);
        await w.dispose();
    });

    test("dispose aborts the in-flight claim and releases it before unregistering", async () => {
        let served = 0;
        const { transport, calls } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                served += 1;
                return served === 1 ? claimResponse(1, "due") : { result: "no_work" };
            }
            if (method === "note.evaluation.abandon") return { result: "abandoned" };
            return { ok: true };
        });
        let aborted = false;
        const w = new SmartNoteEvaluatorWorker({
            transport,
            executors: (_snapshot, signal) => ({
                compile: () => Promise.reject(new Error("compile not expected")),
                confirmFallback: () => Promise.resolve(false),
                runCompiled: () =>
                    new Promise((_resolve, reject) => {
                        signal.addEventListener("abort", () => {
                            aborted = true;
                            reject(new Error("aborted by dispose"));
                        });
                    }),
            }),
            policy: () => ({ retinaHandoff: false, wakeOwned: false }),
            log: () => {},
        });
        const drain = w.drainOnce({ deadline: Date.now() + 30_000 });
        // Let the drain claim the note and block inside the executor.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await w.dispose();
        const result = await drain;
        expect(aborted).toBe(true);
        expect(result.abandoned).toBe(1);
        const methods = calls.map((c) => c.method);
        const abandonAt = methods.indexOf("note.evaluation.abandon");
        const unregisterAt = methods.indexOf("note.evaluation.unregister");
        expect(abandonAt).toBeGreaterThan(-1);
        expect(unregisterAt).toBeGreaterThan(abandonAt);
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

/**
 * The module validates every `note.evaluation.*` body against a CLOSED field set
 * and rejects any unknown key with `bad_request`. These sets mirror the allowlists
 * in `crates/mc-module/src/lib.rs` (handle_note_evaluation_*). A body carrying a
 * field the server does not accept fails the call outright, which previously went
 * unnoticed because the stub transport accepts anything and the Rust tests hand-
 * build bodies rather than replaying the client's.
 */
const SERVER_ALLOWED_FIELDS: Record<EvaluatorMethod, readonly string[]> = {
    "note.evaluation.register": [
        "v",
        "evaluator_instance",
        "protocol_version",
        "policy_version",
        "capacity",
        "retina_handoff",
        "wake_owned",
    ],
    "note.evaluation.heartbeat": [
        "v",
        "token",
        "registration_generation",
        "evaluator_instance",
        "retina_handoff",
        "wake_owned",
    ],
    "note.evaluation.unregister": ["v", "token", "registration_generation", "evaluator_instance"],
    "note.evaluation.next": [
        "v",
        "token",
        "registration_generation",
        "evaluator_instance",
        "evaluator_slot",
        "acquisition_id",
        "wait_ms",
    ],
    "note.evaluation.renew": [
        "v",
        "token",
        "registration_generation",
        "evaluator_instance",
        "evaluator_slot",
        "claim_id",
    ],
    "note.evaluation.complete": [
        "v",
        "token",
        "registration_generation",
        "evaluator_instance",
        "evaluator_slot",
        "claim_id",
        "completion_id",
        "outcome",
    ],
    "note.evaluation.abandon": [
        "v",
        "token",
        "registration_generation",
        "evaluator_instance",
        "evaluator_slot",
        "claim_id",
    ],
};

describe("SmartNoteEvaluatorWorker wire schema conformance", () => {
    test("every sent body stays within the module's closed field set", async () => {
        let served = 0;
        const { transport, calls } = stubTransport((method, body) => {
            // Fail closed exactly like the module does, so a stray field turns
            // into a visible test failure instead of a silently rejected call.
            for (const key of Object.keys(body)) {
                if (key === "method") continue;
                if (!SERVER_ALLOWED_FIELDS[method].includes(key)) {
                    throw new Error(`bad_request: unknown field '${key}' for ${method}`);
                }
            }
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                served += 1;
                return served === 1 ? claimResponse(7, "due") : { result: "no_work" };
            }
            if (method === "note.evaluation.complete") {
                return { result: "applied", note_id: 7, status: "ready" };
            }
            if (method === "note.evaluation.abandon") return { result: "abandoned" };
            return { ok: true };
        });

        const w = worker(transport);
        expect(await w.register()).toBe(true);
        await w.heartbeat();
        await w.drainOnce({ deadline: Date.now() + 5_000 });
        await w.dispose();

        // Exercised the registration-scoped and claim-scoped methods.
        const seen = new Set(calls.map((c) => c.method));
        expect(seen.has("note.evaluation.register")).toBe(true);
        expect(seen.has("note.evaluation.heartbeat")).toBe(true);
        expect(seen.has("note.evaluation.next")).toBe(true);
        expect(seen.has("note.evaluation.complete")).toBe(true);
        expect(seen.has("note.evaluation.unregister")).toBe(true);

        // The heartbeat/unregister fence must NOT carry evaluator_slot; the
        // claim-scoped fence must.
        for (const call of calls) {
            const hasSlot = Object.hasOwn(call.body, "evaluator_slot");
            const slotAllowed = SERVER_ALLOWED_FIELDS[call.method].includes("evaluator_slot");
            expect(hasSlot).toBe(slotAllowed);
        }

        // Registration survived: no call was rejected.
        expect(w.registered).toBe(false); // disposed
    });

    test("abandon releases the claim without sending a reason field", async () => {
        let served = 0;
        const { transport, calls } = stubTransport((method, body) => {
            for (const key of Object.keys(body)) {
                if (key === "method") continue;
                if (!SERVER_ALLOWED_FIELDS[method].includes(key)) {
                    throw new Error(`bad_request: unknown field '${key}' for ${method}`);
                }
            }
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                served += 1;
                return served === 1 ? claimResponse(11, "fallback") : { result: "no_work" };
            }
            if (method === "note.evaluation.abandon") return { result: "abandoned" };
            return { ok: true };
        });
        const w = worker(
            transport,
            passthroughExecutors({ confirmFallback: () => Promise.resolve(null) }),
        );
        const result = await w.drainOnce({ deadline: Date.now() + 5_000 });
        expect(result.abandoned).toBe(1);
        const abandon = calls.find((c) => c.method === "note.evaluation.abandon");
        expect(abandon).toBeDefined();
        expect(Object.hasOwn(abandon?.body ?? {}, "reason")).toBe(false);
        await w.dispose();
    });
});

describe("SmartNoteEvaluatorWorker availability", () => {
    test("a thrown heartbeat drops the registration instead of reporting stale liveness", async () => {
        const { transport } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.heartbeat") {
                throw new Error("registration_unknown");
            }
            return { ok: true };
        });
        const w = worker(transport);
        expect(await w.register()).toBe(true);
        expect(w.registered).toBe(true);
        await w.heartbeat();
        // The module did not renew the lease, so availability must not keep
        // reporting true; otherwise conditioned ctx_note writes are admitted
        // against an evaluator the module has already purged.
        expect(w.registered).toBe(false);
        await w.dispose();
    });

    test("a drain re-registers after the registration was dropped", async () => {
        let registrations = 0;
        let heartbeatShouldFail = true;
        const { transport } = stubTransport((method) => {
            if (method === "note.evaluation.register") {
                registrations += 1;
                return REGISTER_OK;
            }
            if (method === "note.evaluation.heartbeat" && heartbeatShouldFail) {
                throw new Error("registration_unknown");
            }
            if (method === "note.evaluation.next") return { result: "no_work" };
            return { ok: true };
        });
        const w = worker(transport);
        expect(await w.register()).toBe(true);
        expect(registrations).toBe(1);

        // A module restart invalidates the registration; the heartbeat observes it.
        await w.heartbeat();
        expect(w.registered).toBe(false);

        // Drain must recover the registration on its own, otherwise availability
        // is a one-way latch for the life of the process.
        heartbeatShouldFail = false;
        await w.drainOnce({ deadline: Date.now() + 5_000 });
        expect(registrations).toBe(2);
        expect(w.registered).toBe(true);
        await w.dispose();
    });

    test("a replayed completion of a surfaced note counts as surfaced", async () => {
        let served = 0;
        const { transport } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                served += 1;
                return served === 1 ? claimResponse(3, "due") : { result: "no_work" };
            }
            if (method === "note.evaluation.complete") {
                // The module nests the recovered payload for replays.
                return { result: "replayed", response: { note_id: 3, status: "ready" } };
            }
            return { ok: true };
        });
        const w = worker(transport);
        const result = await w.drainOnce({ deadline: Date.now() + 5_000 });
        expect(result.completed).toBe(1);
        expect(result.surfaced).toBe(1);
        await w.dispose();
    });
});
