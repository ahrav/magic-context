import { describe, expect, it } from "bun:test";
import type { KernelTransportCall } from "../kernel-client";
import { FakeKernel } from "./fake-kernel";

function commitCall(operations: unknown[]): KernelTransportCall {
    return {
        sessionId: "session",
        projectRoot: "/repo",
        method: "kernel.commit",
        body: {
            intent: { operation_key: "op-key", request_digest: "digest" },
            tokens: [],
            operations,
            source_kind: "assistant",
        },
    };
}

function decisionSpec(objectId: string): Record<string, unknown> {
    return {
        object_id: objectId,
        domain_id: "memory",
        source_id: "ctx_memory",
        source_revision: 2,
        decision_kind: "ARCHITECTURE",
        payload: { summary: "summary", rationale: "rationale" },
    };
}

describe("FakeKernel commit prevalidation", () => {
    it("rejects two inserts of one id in a single envelope and applies nothing", () => {
        const kernel = new FakeKernel();
        const reply = kernel.reply(
            commitCall([
                { op: "insert_decision", spec: decisionSpec("mem_dup") },
                { op: "insert_decision", spec: decisionSpec("mem_dup") },
            ]),
        );
        expect(reply).toEqual({ state: { kind: "invalid", reason: "already_exists" } });
        expect(kernel.objects.size).toBe(0);
        expect(kernel.tip).toBe(0);
    });

    it("accepts several supersessions sharing one survivor id", () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: "mem_a",
            decision_kind: "ARCHITECTURE",
            summary: "first",
        });
        kernel.seedDecision({
            object_id: "mem_b",
            decision_kind: "ARCHITECTURE",
            summary: "second",
        });
        const reply = kernel.reply(
            commitCall([
                {
                    op: "supersede_decision",
                    replaced_object_id: "mem_a",
                    spec: decisionSpec("mem_survivor"),
                },
                {
                    op: "supersede_decision",
                    replaced_object_id: "mem_b",
                    spec: decisionSpec("mem_survivor"),
                },
            ]),
        ) as { state: { kind: string } };
        expect(reply.state).toEqual({ kind: "available" });
        expect(kernel.objects.get("mem_a")?.superseded_by).toBe("mem_survivor");
        expect(kernel.objects.get("mem_b")?.superseded_by).toBe("mem_survivor");
        expect(kernel.objects.get("mem_survivor")?.invalidated_commit_seq).toBeNull();
    });
});
