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

    test("a thrown registration transport call reports unavailable instead of rejecting", async () => {
        const { transport } = stubTransport(() => {
            throw new Error("connection refused");
        });
        const w = worker(transport);
        expect(await w.register()).toBe(false);
        expect(w.registered).toBe(false);
    });

    test("a registration that resolves after dispose releases the minted token", async () => {
        let releaseRegister: ((value: unknown) => void) | undefined;
        const calls: RecordedCall[] = [];
        const transport: EvaluatorWorkerTransport = {
            call({ method, body }) {
                calls.push({ method, body: body as Record<string, unknown> });
                if (method === "note.evaluation.register") {
                    return new Promise((resolve) => {
                        releaseRegister = resolve;
                    });
                }
                return Promise.resolve({ ok: true });
            },
        };
        const w = worker(transport);
        const registering = w.register();
        await w.dispose();
        releaseRegister?.(REGISTER_OK);
        expect(await registering).toBe(false);
        expect(w.registered).toBe(false);
        // The minted token is released instead of heartbeating forever on a
        // worker no drain path will ever service.
        const unregister = calls.find((c) => c.method === "note.evaluation.unregister");
        expect(unregister?.body.token).toBe("tok-1");
    });

    test("republishes a policy that changed while registration was in flight", async () => {
        const policy = { retinaHandoff: false, wakeOwned: false };
        let releaseRegister: ((value: unknown) => void) | undefined;
        const calls: RecordedCall[] = [];
        const transport: EvaluatorWorkerTransport = {
            call({ method, body }) {
                calls.push({ method, body: body as Record<string, unknown> });
                if (method === "note.evaluation.register") {
                    return new Promise((resolve) => {
                        releaseRegister = resolve;
                    });
                }
                return Promise.resolve({ ok: true });
            },
        };
        const w = new SmartNoteEvaluatorWorker({
            transport,
            executors: passthroughExecutors(),
            policy: () => ({ ...policy }),
            log: () => {},
        });
        const registering = w.register();
        // A drain observes the wake plane while the eager registration is
        // still in flight; joiners share the attempt and its stale snapshot.
        policy.wakeOwned = true;
        releaseRegister?.(REGISTER_OK);
        expect(await registering).toBe(true);
        const register = calls.find((c) => c.method === "note.evaluation.register");
        expect(register?.body.wake_owned).toBe(false);
        const heartbeat = calls.find((c) => c.method === "note.evaluation.heartbeat");
        expect(heartbeat?.body.wake_owned).toBe(true);
        await w.dispose();
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

    test("an exclude-billable drain sends the flag on every poll", async () => {
        let served = 0;
        const { transport, calls } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                served += 1;
                return served <= 1 ? claimResponse(served, "due") : { result: "no_work" };
            }
            if (method === "note.evaluation.complete") return { result: "applied" };
            return { ok: true };
        });
        const w = worker(transport);
        const result = await w.drainOnce({
            deadline: Date.now() + 30_000,
            excludeBillable: true,
        });
        expect(result.completed).toBe(1);
        const nexts = calls.filter((c) => c.method === "note.evaluation.next");
        expect(nexts.length).toBeGreaterThan(0);
        for (const next of nexts) expect(next.body.exclude_billable).toBe(true);
        await w.dispose();
    });

    test("an expired acquisition decision retries with a fresh id", async () => {
        let served = 0;
        const nextIds: string[] = [];
        const { transport } = stubTransport((method, body) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                served += 1;
                nextIds.push(body.acquisition_id as string);
                // A stale replayed decision says nothing about current work;
                // the fresh poll finds the queue empty.
                return served === 1 ? { result: "expired" } : { result: "no_work" };
            }
            return { ok: true };
        });
        const w = worker(transport);
        const result = await w.drainOnce({ deadline: Date.now() + 30_000 });
        expect(result.drained).toBe(true);
        expect(nextIds).toHaveLength(2);
        expect(nextIds[0]).not.toBe(nextIds[1]);
        await w.dispose();
    });

    test("a revision-fence conflict on one claim does not abort the drain", async () => {
        let served = 0;
        let completions = 0;
        const { transport, calls } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                served += 1;
                return served <= 2 ? claimResponse(served, "due") : { result: "no_work" };
            }
            if (method === "note.evaluation.complete") {
                completions += 1;
                // First claim fenced by a concurrent edit; second applies.
                return completions === 1 ? { result: "stale" } : { result: "applied" };
            }
            return { ok: true };
        });
        const w = worker(transport);
        const result = await w.drainOnce({ deadline: Date.now() + 30_000 });
        expect(result).toEqual({
            claimed: 2,
            completed: 1,
            abandoned: 1,
            surfaced: 0,
            drained: true,
        });
        // The fenced claim is already terminal server-side: no abandon call,
        // and the drain moves on to the next note instead of breaking.
        expect(calls.some((c) => c.method === "note.evaluation.abandon")).toBe(false);
        expect(calls.filter((c) => c.method === "note.evaluation.next")).toHaveLength(3);
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

    test("a malformed claim response preserves the acquisition id for replay", async () => {
        // The authority has already leased a note under the acquisition id by
        // the time the payload is validated; discarding the id would strand
        // that lease until expiry.
        let malformed = true;
        const sawAcquisitionIds: string[] = [];
        const { transport } = stubTransport((method, body) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                sawAcquisitionIds.push(String(body.acquisition_id));
                if (malformed) {
                    malformed = false;
                    return { result: "claim", claim_id: 42, note_id: "not-a-number" };
                }
                return { result: "no_work" };
            }
            return { ok: true };
        });
        const w = worker(transport);
        const first = await w.drainOnce({ deadline: Date.now() + 5_000 });
        expect(first.drained).toBe(false);
        expect(first.claimed).toBe(0);
        const second = await w.drainOnce({ deadline: Date.now() + 5_000 });
        expect(second.drained).toBe(true);
        expect(sawAcquisitionIds).toHaveLength(2);
        expect(sawAcquisitionIds[0]).toBe(sawAcquisitionIds[1]);
        await w.dispose();
    });

    test("an immediate no_work response ends the drain without claiming", async () => {
        const { transport } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") return { result: "no_work" };
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

    test("a drain stops issuing compiler prompts at the per-run cap", async () => {
        // The authority's MAX_COMPILE_PER_RUN truncates one selection poll;
        // each subsequent poll admits the next candidate, so the worker owns
        // the whole-drain bound.
        let served = 0;
        const { transport, calls } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                served += 1;
                return claimResponse(served, "compile");
            }
            if (method === "note.evaluation.complete") return { result: "applied" };
            if (method === "note.evaluation.abandon") return { result: "abandoned" };
            return { ok: true };
        });
        let compiles = 0;
        const w = worker(
            transport,
            passthroughExecutors({
                compile: () => {
                    compiles += 1;
                    return Promise.resolve({
                        ok: true,
                        compiledCheck: "function check() { return { met: false }; }",
                        manifest: { capabilities: [] },
                        checkCron: "0 * * * *",
                        checkHash: "h".repeat(64),
                        dryRun: { met: false },
                    });
                },
            }),
        );
        const result = await w.drainOnce({ deadline: Date.now() + 30_000 });
        expect(compiles).toBe(5);
        expect(result.completed).toBe(5);
        expect(result.abandoned).toBe(1);
        expect(calls.filter((c) => c.method === "note.evaluation.abandon")).toHaveLength(1);
        await w.dispose();
    });

    test("concurrent drain calls run one at a time", async () => {
        let served = 0;
        let releaseClaim: (() => void) | undefined;
        const { transport, calls } = stubTransport((method) => {
            if (method === "note.evaluation.register") return REGISTER_OK;
            if (method === "note.evaluation.next") {
                served += 1;
                return served === 1 ? claimResponse(1, "due") : { result: "no_work" };
            }
            if (method === "note.evaluation.complete") return { result: "applied" };
            return { ok: true };
        });
        const w = worker(
            transport,
            passthroughExecutors({
                runCompiled: () =>
                    new Promise((resolve) => {
                        releaseClaim = () => resolve({ ok: true, result: { met: true } });
                    }),
            }),
        );
        const first = w.drainOnce({ deadline: Date.now() + 30_000 });
        const second = w.drainOnce({ deadline: Date.now() + 30_000 });
        // Let the first drain claim and block inside its executor; the second
        // drain must not poll while the first still owns the slot.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const nextsWhileBlocked = calls.filter((c) => c.method === "note.evaluation.next").length;
        expect(nextsWhileBlocked).toBe(1);
        releaseClaim?.();
        const [a, b] = await Promise.all([first, second]);
        expect(a.completed).toBe(1);
        expect(b.drained).toBe(true);
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
        // A rejected heartbeat silently drops the registration, so assert it
        // survived BEFORE dispose; this is the check that catches a heartbeat
        // body carrying a field outside the server's closed set.
        expect(w.registered).toBe(true);
        await w.drainOnce({ deadline: Date.now() + 5_000 });
        expect(w.registered).toBe(true);
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
