import { describe, expect, test } from "bun:test";
import { McHostCallError } from "../mc-host-client/errors";
import {
    type DecisionSpecInput,
    deriveObjectId,
    deriveOperationKey,
    deriveRequestDigest,
    isAvailable,
    KernelClient,
    type KernelTransport,
    type KernelTransportCall,
    kernelMemorySnapshotFrom,
} from "./client";

const PROJECT = "/repo/project";
const SESSION = "session-a";

type Reply = unknown | ((call: KernelTransportCall) => unknown | Promise<unknown>);

class FakeTransport implements KernelTransport {
    calls: KernelTransportCall[] = [];
    rebinds = 0;
    fileExists = true;
    private replies: Reply[] = [];
    rebindError: Error | null = null;

    queue(...replies: Reply[]): this {
        this.replies.push(...replies);
        return this;
    }

    connectionFileExists(): boolean {
        return this.fileExists;
    }

    async call(args: KernelTransportCall): Promise<unknown> {
        this.calls.push(args);
        const reply = this.replies.shift();
        if (reply === undefined) throw new Error(`no scripted reply for ${args.method}`);
        const value = typeof reply === "function" ? await reply(args) : reply;
        if (value instanceof Error) throw value;
        return value;
    }

    async ensureRoute(): Promise<void> {
        this.rebinds += 1;
        if (this.rebindError) throw this.rebindError;
    }

    bodies(method: string): Record<string, unknown>[] {
        return this.calls
            .filter((call) => call.method === method)
            .map((call) => call.body as Record<string, unknown>);
    }
}

function client(transport: FakeTransport, enabled = true): KernelClient {
    return new KernelClient({ transport, enabled, sessionId: SESSION, projectRoot: PROJECT });
}

function row(objectId: string, knownAsOf: number) {
    return {
        object: {
            object_id: objectId,
            object_kind: "decision",
            domain_id: "memory",
            source_kind: "assistant",
            source_id: "memory-lineage",
            source_revision: 1,
            created_commit_seq: 1,
            invalidated_commit_seq: null,
            superseded_by: null,
            sensitivity: "normal",
        },
        visibility: "labeled",
        labeled: true,
        scope_id: "project:x",
        token: { object_id: objectId, known_as_of: knownAsOf },
        decision: { decision_kind: "memory", payload: { summary: objectId, rationale: "" } },
    };
}

function readReply(knownAsOf: number, ...objectIds: string[]) {
    return {
        state: { kind: "available" },
        known_as_of: knownAsOf,
        tip: knownAsOf,
        gated: false,
        rows: objectIds.map((id) => row(id, knownAsOf)),
    };
}

function commitReply(commitSeq: number, replayed: boolean, ...objectIds: string[]) {
    return {
        state: { kind: "available" },
        receipt: { commit_seq: commitSeq, replayed },
        known_as_of: commitSeq,
        tokens: objectIds.map((id) => ({ object_id: id, known_as_of: commitSeq })),
    };
}

const DIVERGED = { state: { kind: "unavailable", reason: "snapshot_diverged" } };

const spec: DecisionSpecInput = {
    decision_id: "decision-1",
    object_id: "decision-object-1",
    domain_id: "memory",
    decision_kind: "memory",
    payload: { summary: "s", rationale: "r" },
    source_id: "memory-lineage",
    source_revision: 1,
};

const intent = { actor: "assistant", operationId: "session-1\u001fcall-1", cause: "ctx_memory" };

describe("KernelClient gating", () => {
    test("disabled returns before any transport work", async () => {
        const transport = new FakeTransport();
        transport.fileExists = false;
        const result = await client(transport, false).read({ surface: "auto_inject" });
        expect(result.state).toEqual({ kind: "disabled" });
        expect(transport.calls).toHaveLength(0);
    });

    test("a missing connection file is daemon_absent with no route opened", async () => {
        const transport = new FakeTransport();
        transport.fileExists = false;
        const result = await client(transport).read({ surface: "auto_inject" });
        expect(result.state).toEqual({ kind: "unavailable", reason: "daemon_absent" });
        expect(transport.calls).toHaveLength(0);
        expect(transport.rebinds).toBe(0);
    });

    test("an already-aborted signal is cancelled with no transport call", async () => {
        const transport = new FakeTransport();
        const controller = new AbortController();
        controller.abort();
        const result = await client(transport).read({
            surface: "auto_inject",
            signal: controller.signal,
        });
        expect(result.state).toEqual({ kind: "cancelled" });
        expect(transport.calls).toHaveLength(0);
    });

    test("a signal aborted mid-call is cancelled", async () => {
        const transport = new FakeTransport();
        const controller = new AbortController();
        transport.queue(() => {
            controller.abort();
            throw new Error("module transport call aborted");
        });
        const result = await client(transport).read({
            surface: "auto_inject",
            signal: controller.signal,
        });
        expect(result.state).toEqual({ kind: "cancelled" });
        expect(transport.calls).toHaveLength(1);
    });

    test("an outcome_unknown racing an abort keeps its classification instead of cancelled", async () => {
        const transport = new FakeTransport();
        const controller = new AbortController();
        transport.queue(() => {
            controller.abort();
            throw new McHostCallError("outcome_unknown", "deadline", "request_deadline");
        });
        // The commit was sent and may have been applied; reporting a plain cancellation would invite a retry under a fresh identity and a duplicate commit. commentlint: allow(JUDGE)
        const result = await client(transport).create(spec, {
            ...intent,
            signal: controller.signal,
        });
        expect(result.state).toEqual({ kind: "unavailable", reason: "outcome_unknown" });
        expect(transport.bodies("kernel.commit")).toHaveLength(1);
    });
});

describe("KernelClient transport mapping", () => {
    test("not_sent is daemon_absent", async () => {
        const transport = new FakeTransport().queue(new McHostCallError("not_sent", "never wrote"));
        const result = await client(transport).read({ surface: "auto_inject" });
        expect(result.state).toEqual({ kind: "unavailable", reason: "daemon_absent" });
        expect(transport.calls).toHaveLength(1);
    });

    test("ECONNREFUSED and a closed socket are daemon_absent", async () => {
        const refused = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
        const closed = Object.assign(new Error("closed"), { name: "SocketClosedError" });
        for (const error of [refused, closed]) {
            const transport = new FakeTransport().queue(error);
            const result = await client(transport).read({ surface: "auto_inject" });
            expect(result.state).toEqual({ kind: "unavailable", reason: "daemon_absent" });
        }
    });

    test("outcome_unknown on a read reissues once and serves the retried response", async () => {
        const transport = new FakeTransport().queue(
            new McHostCallError("outcome_unknown", "deadline", "request_deadline"),
            readReply(1),
        );
        const result = await client(transport).read({ surface: "auto_inject" });
        expect(isAvailable(result)).toBe(true);
        expect(transport.calls).toHaveLength(2);
    });

    test("a second outcome_unknown on the same read is daemon_absent", async () => {
        const transport = new FakeTransport().queue(
            new McHostCallError("outcome_unknown", "deadline"),
            new McHostCallError("outcome_unknown", "deadline"),
        );
        const result = await client(transport).read({ surface: "auto_inject" });
        expect(result.state).toEqual({ kind: "unavailable", reason: "daemon_absent" });
        expect(transport.calls).toHaveLength(2);
    });

    test("outcome_unknown on a write is reissued once with identical bytes", async () => {
        const transport = new FakeTransport().queue(
            new McHostCallError("outcome_unknown", "deadline", "request_deadline"),
            commitReply(5, true, "decision-object-1"),
        );
        const result = await client(transport).create(spec, intent);
        expect(isAvailable(result)).toBe(true);
        if (!isAvailable(result)) throw new Error("unreachable");
        expect(result.receipt.replayed).toBe(true);
        const bodies = transport.bodies("kernel.commit");
        expect(bodies).toHaveLength(2);
        expect(JSON.stringify(bodies[0])).toBe(JSON.stringify(bodies[1]));
    });

    test("a second outcome_unknown on the same write stays ambiguous", async () => {
        const transport = new FakeTransport().queue(
            new McHostCallError("outcome_unknown", "deadline"),
            new McHostCallError("outcome_unknown", "deadline"),
        );
        const result = await client(transport).create(spec, intent);
        // Both attempts were sent and either may have committed; daemon_absent would read as a definitive failure and invite a fresh-identity retry. commentlint: allow(JUDGE)
        expect(result.state).toEqual({ kind: "unavailable", reason: "outcome_unknown" });
        expect(transport.bodies("kernel.commit")).toHaveLength(2);
    });

    test("a write reissue that is never sent keeps the first attempt's ambiguity", async () => {
        const transport = new FakeTransport().queue(
            new McHostCallError("outcome_unknown", "deadline"),
            new McHostCallError("not_sent", "connection retired"),
        );
        const result = await client(transport).create(spec, intent);
        // `not_sent` proves only that the reissue never left; the first attempt may still have committed. commentlint: allow(JUDGE)
        expect(result.state).toEqual({ kind: "unavailable", reason: "outcome_unknown" });
        expect(transport.bodies("kernel.commit")).toHaveLength(2);
    });

    test("an undecodable commit response stays ambiguous instead of a definitive error", async () => {
        const transport = new FakeTransport().queue({ garbage: true });
        const result = await client(transport).create(spec, intent);
        // The transport delivered a response, so the commit may have applied; only its receipt was lost to the malformed payload. commentlint: allow(JUDGE)
        expect(result.state).toEqual({ kind: "unavailable", reason: "outcome_unknown" });
    });

    test("route_unbound rebinds once, then retries once, then is daemon_absent", async () => {
        const unbound = () => new McHostCallError("terminal", "no binding", "route_unbound");
        const recovered = new FakeTransport().queue(unbound(), readReply(1));
        const ok = await client(recovered).read({ surface: "auto_inject" });
        expect(ok.state).toEqual({ kind: "available" });
        expect(recovered.rebinds).toBe(1);
        expect(recovered.calls).toHaveLength(2);

        const stuck = new FakeTransport().queue(unbound(), unbound());
        const absent = await client(stuck).read({ surface: "auto_inject" });
        expect(absent.state).toEqual({ kind: "unavailable", reason: "daemon_absent" });
        expect(stuck.rebinds).toBe(1);
        expect(stuck.calls).toHaveLength(2);
    });

    test("other terminal codes and foreign errors are invalid(internal)", async () => {
        for (const error of [
            new McHostCallError("terminal", "bad", "bad_request"),
            new McHostCallError("terminal", "bad", "session_mismatch"),
            new TypeError("boom"),
        ]) {
            const transport = new FakeTransport().queue(error);
            const result = await client(transport).read({ surface: "auto_inject" });
            expect(result.state).toEqual({ kind: "invalid", reason: "internal" });
        }
    });

    test("an unparseable success body is unrecognized_state", async () => {
        const transport = new FakeTransport().queue({ state: { kind: "available" }, rows: 3 });
        const result = await client(transport).read({ surface: "auto_inject" });
        expect(result.state).toEqual({ kind: "invalid", reason: "unrecognized_state" });
    });

    test("a daemon without kernel routes is unrecognized_state, not internal", async () => {
        for (const code of ["unrecognized_request_shape", "facade_envelope_not_supported"]) {
            const transport = new FakeTransport().queue(
                new McHostCallError("terminal", "no such method", code),
            );
            const result = await client(transport).read({ surface: "auto_inject" });
            expect(result.state).toEqual({ kind: "invalid", reason: "unrecognized_state" });
        }
    });

    test("a decision row without its decision payload fails the whole read", async () => {
        const { decision: _decision, ...bare } = row("o1", 3);
        const transport = new FakeTransport().queue({
            state: { kind: "available" },
            known_as_of: 3,
            tip: 3,
            gated: false,
            rows: [bare],
        });
        const result = await client(transport).read({ surface: "explicit_search" });
        expect(result.state).toEqual({ kind: "invalid", reason: "unrecognized_state" });
    });
});

describe("KernelClient reads", () => {
    test("read sends the wire shape and mints tokens", async () => {
        const transport = new FakeTransport().queue(readReply(9, "o1", "o2"));
        const c = client(transport);
        const result = await c.read({ surface: "explicit_search", asOf: 9, gated: true });
        expect(transport.bodies("kernel.read")[0]).toEqual({
            method: "kernel.read",
            v: 1,
            session_id: SESSION,
            project_root: PROJECT,
            surface: "explicit_search",
            as_of: 9,
            gated: true,
        });
        expect(isAvailable(result) && result.rows.length).toBe(2);
        expect(c.tokens.get(PROJECT, "o2")).toEqual({ object_id: "o2", known_as_of: 9 });
    });

    test("a lagging read keeps its lag facts and carries no rows", async () => {
        const transport = new FakeTransport().queue({
            state: { kind: "stale", lag_positions: 12, oldest_unconsumed_age_ms: 900 },
        });
        const result = await client(transport).read({ surface: "explicit_search", gated: true });
        expect(result.state).toEqual({
            kind: "stale",
            lag_positions: 12,
            oldest_unconsumed_age_ms: 900,
        });
        expect("rows" in result).toBe(false);
    });

    test("snapshot_diverged on read drops tokens and re-reads the tip once", async () => {
        const transport = new FakeTransport().queue(
            readReply(3, "o1"),
            DIVERGED,
            readReply(4, "o1"),
        );
        const c = client(transport);
        await c.read({ surface: "auto_inject" });
        const result = await c.read({ surface: "auto_inject", asOf: 99 });
        expect(result.state).toEqual({ kind: "available" });
        const bodies = transport.bodies("kernel.read");
        expect(bodies[1]?.as_of).toBe(99);
        expect(bodies[2]?.as_of).toBeNull();
        expect(c.tokens.get(PROJECT, "o1")?.known_as_of).toBe(4);
    });

    test("a second divergence in one call stays unavailable with tokens dropped", async () => {
        const transport = new FakeTransport().queue(readReply(3, "o1"), DIVERGED, DIVERGED);
        const c = client(transport);
        await c.read({ surface: "auto_inject" });
        const result = await c.read({ surface: "auto_inject", asOf: 99 });
        expect(result.state).toEqual({ kind: "unavailable", reason: "snapshot_diverged" });
        expect(transport.calls).toHaveLength(3);
        expect(c.tokens.get(PROJECT, "o1")).toBeUndefined();
        expect(c.tokens.knownAsOfFor(PROJECT)).toBeUndefined();
    });

    test("a filtered read carries object_ids on the wire", async () => {
        const transport = new FakeTransport().queue(readReply(5, "o1"));
        const result = await client(transport).read({
            surface: "explicit_search",
            objectIds: ["o1", "o2"],
        });
        expect(isAvailable(result)).toBe(true);
        expect(transport.bodies("kernel.read")[0]?.object_ids).toEqual(["o1", "o2"]);
    });

    test("an unfiltered read omits object_ids from the wire", async () => {
        const transport = new FakeTransport().queue(readReply(5, "o1"));
        await client(transport).read({ surface: "explicit_search" });
        expect("object_ids" in (transport.bodies("kernel.read")[0] ?? {})).toBe(false);
    });

    test("an over-limit objectIds filter is invalid_input with no transport call", async () => {
        const transport = new FakeTransport();
        const objectIds = Array.from({ length: 65 }, (_, index) => `o${index}`);
        const result = await client(transport).read({ surface: "explicit_search", objectIds });
        expect(result.state).toEqual({ kind: "invalid", reason: "invalid_input" });
        expect(transport.calls).toHaveLength(0);
    });
});

describe("KernelClient mutations", () => {
    test("operation_key is a deterministic function of the operation identity and project", () => {
        const operations = [{ op: "insert_decision" as const, spec }];
        const digest = deriveRequestDigest(operations);
        expect(digest).toBe(deriveRequestDigest([{ op: "insert_decision", spec: { ...spec } }]));
        const key = deriveOperationKey({
            projectRoot: PROJECT,
            producer: "plugin",
            actor: "a",
            operationId: "s\u001fc",
        });
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(
            deriveOperationKey({
                projectRoot: "/other",
                producer: "plugin",
                actor: "a",
                operationId: "s\u001fc",
            }),
        ).not.toBe(key);
    });

    test("the same operation identity keeps its key while a changed body changes only the digest", () => {
        const key = deriveOperationKey({
            projectRoot: PROJECT,
            producer: "plugin",
            actor: "a",
            operationId: "session-1\u001fcall-1",
        });
        expect(
            deriveOperationKey({
                projectRoot: PROJECT,
                producer: "plugin",
                actor: "a",
                operationId: "session-1\u001fcall-1",
            }),
        ).toBe(key);
        const digest = deriveRequestDigest([{ op: "insert_decision", spec }]);
        const otherDigest = deriveRequestDigest([
            { op: "retire_decision", object_id: "mem_other" },
        ]);
        expect(digest).toBe(deriveRequestDigest([{ op: "insert_decision", spec: { ...spec } }]));
        expect(otherDigest).not.toBe(digest);
    });

    test("sessions reusing one tool-call id derive distinct keys", () => {
        const parts = { projectRoot: PROJECT, producer: "plugin", actor: "a" };
        expect(deriveOperationKey({ ...parts, operationId: "session-1\u001fcall-1" })).not.toBe(
            deriveOperationKey({ ...parts, operationId: "session-2\u001fcall-1" }),
        );
    });

    test("deriveObjectId joins the fields under the unit separator and pins byte-for-byte", () => {
        // The literal detects changes to hash inputs, separator, field order, or slice.
        expect(deriveObjectId("mem", "a", "b")).toBe("mem_f04cdced9736a69da6103f08a4daaf8c");
        expect(deriveObjectId("dec", "a", "b")).toBe("dec_f04cdced9736a69da6103f08a4daaf8c");
        expect(deriveObjectId("mem", "a\u001fb")).toBe(deriveObjectId("mem", "a", "b"));
        expect(deriveObjectId("mem", "a", "b")).not.toBe(deriveObjectId("mem", "b", "a"));
    });

    test("create sends one insert_decision under a derived intent", async () => {
        const transport = new FakeTransport().queue(commitReply(2, false, spec.object_id));
        const c = client(transport);
        const result = await c.create(spec, { ...intent, sourceKind: "assistant" });
        expect(isAvailable(result)).toBe(true);
        const body = transport.bodies("kernel.commit")[0] as Record<string, unknown>;
        expect(body.operations).toEqual([{ op: "insert_decision", spec }]);
        expect(body.tokens).toEqual([]);
        expect(body.source_kind).toBe("assistant");
        const wireIntent = body.intent as Record<string, string>;
        expect(wireIntent.producer).toBe("plugin");
        expect(wireIntent.request_digest).toBe(
            deriveRequestDigest([{ op: "insert_decision", spec }]),
        );
        expect(wireIntent.cause).toBe(intent.cause);
        expect(wireIntent.operation_key).toBe(
            deriveOperationKey({
                projectRoot: PROJECT,
                producer: "plugin",
                actor: intent.actor,
                operationId: intent.operationId,
            }),
        );
        expect(c.tokens.get(PROJECT, spec.object_id)?.known_as_of).toBe(2);
    });

    test("the free-text cause travels in the intent and never enters the operation key", async () => {
        const transport = new FakeTransport().queue(
            commitReply(2, false, spec.object_id),
            commitReply(3, false, spec.object_id),
        );
        const c = client(transport);
        await c.create(spec, { ...intent, cause: "call-1 reason: superseded" });
        await c.create(spec, { ...intent, cause: "call-1 reason: obsolete" });
        const [first, second] = transport
            .bodies("kernel.commit")
            .map((body) => (body as { intent: Record<string, string> }).intent);
        expect(first?.cause).toBe("call-1 reason: superseded");
        expect(second?.cause).toBe("call-1 reason: obsolete");
        expect(first?.operation_key).toBe(second?.operation_key);
    });

    test("a mutation without a cached token does one ungated explicit_search read first", async () => {
        const transport = new FakeTransport().queue(
            readReply(6, "old-object"),
            commitReply(7, false, "old-object", spec.object_id),
        );
        const result = await client(transport).revise("old-object", spec, intent);
        expect(isAvailable(result)).toBe(true);
        expect(transport.calls.map((call) => call.method)).toEqual([
            "kernel.read",
            "kernel.commit",
        ]);
        const read = transport.bodies("kernel.read")[0];
        expect(read?.surface).toBe("explicit_search");
        expect(read?.gated).toBe(false);
        expect(read?.as_of).toBeNull();
        expect(read?.object_ids).toEqual(["old-object"]);
        expect(transport.bodies("kernel.commit")[0]?.tokens).toEqual([
            { object_id: "old-object", known_as_of: 6 },
        ]);
    });

    test("a cached token skips the pre-read", async () => {
        const transport = new FakeTransport().queue(
            readReply(3, "o1"),
            commitReply(4, false, "o1"),
        );
        const c = client(transport);
        await c.read({ surface: "auto_inject" });
        await c.archive("o1", intent);
        expect(transport.calls.map((call) => call.method)).toEqual([
            "kernel.read",
            "kernel.commit",
        ]);
        expect(transport.bodies("kernel.commit")[0]?.operations).toEqual([
            { op: "retire_decision", object_id: "o1" },
        ]);
        expect(transport.bodies("kernel.commit")[0]?.tokens).toEqual([
            { object_id: "o1", known_as_of: 3 },
        ]);
    });

    test("merge supersedes every object with one survivor in one envelope", async () => {
        const transport = new FakeTransport().queue(
            readReply(3, "a", "b"),
            commitReply(4, false, "a", "b", spec.object_id),
        );
        await client(transport).merge(["a", "b"], spec, intent);
        expect(transport.bodies("kernel.commit")).toHaveLength(1);
        expect(transport.bodies("kernel.commit")[0]?.operations).toEqual([
            { op: "supersede_decision", replaced_object_id: "a", spec },
            { op: "supersede_decision", replaced_object_id: "b", spec },
        ]);
    });

    test("snapshot_diverged on commit drops tokens, re-reads the tip, and commits once more", async () => {
        const transport = new FakeTransport().queue(
            readReply(3, "o1"),
            DIVERGED,
            readReply(8, "o1"),
            commitReply(9, false, "o1"),
        );
        const c = client(transport);
        await c.read({ surface: "auto_inject" });
        const result = await c.archive("o1", intent);
        expect(isAvailable(result)).toBe(true);
        expect(transport.calls.map((call) => call.method)).toEqual([
            "kernel.read",
            "kernel.commit",
            "kernel.read",
            "kernel.commit",
        ]);
        expect(transport.bodies("kernel.commit")[1]?.tokens).toEqual([
            { object_id: "o1", known_as_of: 8 },
        ]);
    });

    test("a second divergence in the same commit returns snapshot_diverged", async () => {
        const transport = new FakeTransport().queue(
            readReply(3, "o1"),
            DIVERGED,
            readReply(8, "o1"),
            DIVERGED,
        );
        const c = client(transport);
        await c.read({ surface: "auto_inject" });
        const result = await c.archive("o1", intent);
        expect(result.state).toEqual({ kind: "unavailable", reason: "snapshot_diverged" });
        expect(transport.calls).toHaveLength(4);
        expect(c.tokens.get(PROJECT, "o1")).toBeUndefined();
    });

    test("a target still absent after the refresh read is never committed", async () => {
        const transport = new FakeTransport().queue(readReply(3, "other"));
        const result = await client(transport).archive("foreign", intent);
        expect(result.state).toEqual({ kind: "conflict", reason: "retracted" });
        expect(transport.bodies("kernel.commit")).toHaveLength(0);
    });

    test("a conflict from the daemon passes through", async () => {
        const transport = new FakeTransport().queue(readReply(3, "o1"), {
            state: { kind: "conflict", reason: "known_as_of_advanced" },
        });
        const result = await client(transport).archive("o1", intent);
        expect(result.state).toEqual({ kind: "conflict", reason: "known_as_of_advanced" });
    });
});

describe("kernelMemorySnapshotFrom", () => {
    test("an available read's truncated flag rides the snapshot projection", async () => {
        const transport = new FakeTransport().queue({ ...readReply(9, "o1"), truncated: true });
        const read = await client(transport).read({ surface: "explicit_search" });
        expect(kernelMemorySnapshotFrom(read)).toMatchObject({
            rows: [
                expect.objectContaining({ object: expect.objectContaining({ object_id: "o1" }) }),
            ],
            knownAsOf: 9,
            truncated: true,
        });
    });

    test("a complete read projects truncated false", async () => {
        const transport = new FakeTransport().queue(readReply(9, "o1"));
        const read = await client(transport).read({ surface: "explicit_search" });
        expect(kernelMemorySnapshotFrom(read).truncated).toBe(false);
    });

    test("a non-available read projects no rows and no truncation", async () => {
        const transport = new FakeTransport().queue({
            state: { kind: "unavailable", reason: "store_busy" },
        });
        const read = await client(transport).read({ surface: "explicit_search" });
        expect(kernelMemorySnapshotFrom(read)).toEqual({
            state: { kind: "unavailable", reason: "store_busy" },
            rows: [],
            knownAsOf: null,
        });
    });
});
