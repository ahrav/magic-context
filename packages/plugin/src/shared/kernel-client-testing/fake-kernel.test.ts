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

    it("answers not_found for a replacement id another project holds", () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: "mem_a",
            decision_kind: "ARCHITECTURE",
            summary: "ours",
            projectRoot: "/repo",
        });
        kernel.seedDecision({
            object_id: "mem_theirs",
            decision_kind: "ARCHITECTURE",
            summary: "theirs",
            projectRoot: "/elsewhere",
        });
        const reply = kernel.reply(
            commitCall([
                {
                    op: "supersede_decision",
                    replaced_object_id: "mem_a",
                    spec: decisionSpec("mem_theirs"),
                },
            ]),
        );
        expect(reply).toEqual({ state: { kind: "invalid", reason: "not_found" } });
        expect(kernel.objects.get("mem_a")?.invalidated_commit_seq).toBeNull();
    });

    it("floors a non-fold successor's sensitivity at its predecessor's", () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: "mem_a",
            decision_kind: "ARCHITECTURE",
            summary: "guarded",
            sensitivity: "sensitive",
        });
        const reply = kernel.reply(
            commitCall([
                {
                    op: "supersede_decision",
                    replaced_object_id: "mem_a",
                    spec: { ...decisionSpec("mem_b"), sensitivity: "normal" },
                },
            ]),
        ) as { state: { kind: string }; merged: string[] };
        expect(reply.state).toEqual({ kind: "available" });
        expect(reply.merged).toEqual([]);
        expect(kernel.objects.get("mem_b")?.sensitivity).toBe("sensitive");
    });
});

function readCall(body: Record<string, unknown>): KernelTransportCall {
    return {
        sessionId: "session",
        projectRoot: "/repo",
        method: "kernel.read",
        body: { surface: "explicit_search", gated: false, ...body },
    };
}

interface ReadReply {
    truncated: boolean;
    rows: { object: { object_id: string } }[];
}

function seedThree(kernel: FakeKernel): void {
    kernel.seedDecision({ object_id: "mem_a", decision_kind: "ARCHITECTURE", summary: "oldest" });
    kernel.seedDecision({ object_id: "mem_b", decision_kind: "ARCHITECTURE", summary: "middle" });
    kernel.seedDecision({ object_id: "mem_c", decision_kind: "ARCHITECTURE", summary: "newest" });
}

describe("FakeKernel read filtering and row cap", () => {
    it("scopes rows to the object_ids filter", () => {
        const kernel = new FakeKernel();
        seedThree(kernel);
        const reply = kernel.reply(readCall({ object_ids: ["mem_b"] })) as ReadReply;
        expect(reply.rows.map((row) => row.object.object_id)).toEqual(["mem_b"]);
        expect(reply.truncated).toBe(false);
    });

    it("caps unfiltered reads to the newest rows and flags truncation", () => {
        const kernel = new FakeKernel();
        seedThree(kernel);
        kernel.readRowCap = 2;
        const reply = kernel.reply(readCall({})) as ReadReply;
        expect(reply.rows.map((row) => row.object.object_id)).toEqual(["mem_b", "mem_c"]);
        expect(reply.truncated).toBe(true);
    });

    it("applies the id filter before the row cap, so a filtered read reaches a dropped row", () => {
        const kernel = new FakeKernel();
        seedThree(kernel);
        kernel.readRowCap = 2;
        const reply = kernel.reply(readCall({ object_ids: ["mem_a"] })) as ReadReply;
        expect(reply.rows.map((row) => row.object.object_id)).toEqual(["mem_a"]);
        expect(reply.truncated).toBe(false);
    });
});
