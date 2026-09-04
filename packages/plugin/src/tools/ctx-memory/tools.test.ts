import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DREAMER_AGENT } from "../../agents/dreamer";
import { KernelClient, TokenCache } from "../../shared/kernel-client";
import { FakeKernel, FakeKernelTransport } from "../../shared/kernel-client-testing/fake-kernel";
import { createCtxMemoryTools } from "./tools";

const PROJECT = "git:kernel-opencode";
const ROOT = "/tmp/kernel-opencode";
const SESSION = "ses-kernel-opencode";

interface CommitJson {
    action: string;
    outcome: string;
    commitSeq: number;
    knownAsOf: number;
    objectId?: string;
    objects: string[];
}

interface ReadJson {
    action: string;
    knownAsOf: number;
    memories: Array<{
        objectId: string;
        category: string;
        content: string;
        antiMemory?: Record<string, string | null>;
        labeled: boolean;
    }>;
    missingObjectIds?: string[];
}

function harness(kernel = new FakeKernel(), enabled = true) {
    const transport = new FakeKernelTransport(kernel);
    const tokens = new TokenCache();
    const definition = createCtxMemoryTools({
        kernelClient: ({ sessionId, projectRoot }) =>
            new KernelClient({ transport, enabled, sessionId, projectRoot, tokens }),
        resolveProjectPath: () => PROJECT,
        allowedActions: ["create", "get", "revise", "archive", "merge"],
    }).ctx_memory;
    const execute = async (
        args: Record<string, unknown>,
        callID: string,
        agent = "primary",
    ): Promise<string> =>
        definition.execute(
            args as never,
            { sessionID: SESSION, directory: ROOT, callID, agent } as never,
        ) as Promise<string>;
    return { definition, execute, transport, kernel, tokens };
}

function parseJson<T>(text: string): T {
    expect(text.startsWith("Error:")).toBeFalse();
    return JSON.parse(text) as T;
}

function createArgs(content: string) {
    return { action: "create", category: "ARCHITECTURE", content };
}

function reduced(inner: Record<string, unknown>) {
    return { reduced: true, summary: JSON.stringify(inner) };
}

describe("ctx_memory without a daemon", () => {
    test("list answers with the unavailable text, no retry wording, and no kernel call", async () => {
        const tool = harness();
        tool.transport.fileExists = false;
        const text = await tool.execute({ action: "list" }, "call-list", DREAMER_AGENT);
        expect(text).toBe("Error: Memory is unavailable because the daemon is not running.");
        expect(text.toLowerCase()).not.toContain("retry");
        expect(tool.transport.calls).toHaveLength(0);
    });

    test("a disabled client answers with the disabled text", async () => {
        const tool = harness(new FakeKernel(), false);
        expect(await tool.execute(createArgs("x"), "call-disabled")).toBe(
            "Error: Memory is disabled by configuration (memory.enabled = false).",
        );
    });
});

describe("ctx_memory create and revise through the cached token", () => {
    test("create then revise by object id issues one read for the token and supersedes", async () => {
        const tool = harness();
        const created = parseJson<CommitJson>(
            await tool.execute(createArgs("OpenCode uses the kernel."), "call-create"),
        );
        expect(created).toMatchObject({ action: "create", outcome: "applied", commitSeq: 1 });
        expect(created.objects).toHaveLength(1);
        const objectId = created.objects[0] as string;
        expect(created.objectId).toBe(objectId);
        expect(objectId).toMatch(/^mem_[0-9a-f]{32}$/);
        expect(tool.kernel.objects.get(objectId)?.decision).toEqual({
            decision_kind: "ARCHITECTURE",
            payload: { summary: "OpenCode uses the kernel.", rationale: "" },
        });

        const revised = parseJson<CommitJson>(
            await tool.execute(
                { action: "revise", objectId, content: "OpenCode uses the kernel routes." },
                "call-revise",
            ),
        );
        expect(revised.outcome).toBe("applied");
        expect(revised.objects).toContain(objectId);
        const survivor = revised.objects.find((id) => id !== objectId) as string;
        // The tool result names the survivor apart from the retired predecessor.
        expect(revised.objectId).toBe(survivor);
        expect(tool.kernel.objects.get(objectId)?.superseded_by).toBe(survivor);
        expect(tool.kernel.objects.get(survivor)?.decision?.payload.summary).toBe(
            "OpenCode uses the kernel routes.",
        );
        expect(tool.kernel.objects.get(survivor)?.decision?.decision_kind).toBe("ARCHITECTURE");
        // The tool's own read supplies the token; the client does not read a second time.
        expect(tool.transport.methods()).toEqual(["kernel.commit", "kernel.read", "kernel.commit"]);
        const commit = tool.transport.calls[2]?.body as { tokens: unknown[] };
        expect(commit.tokens).toEqual([{ object_id: objectId, known_as_of: 1 }]);
    });

    test("revise after a concurrent change renders the conflict directive", async () => {
        const tool = harness();
        const seeded = tool.kernel.seedDecision({
            object_id: "mem_seeded",
            decision_kind: "CONSTRAINTS",
            summary: "Seeded.",
        });
        // Prime the token cache from a read, then let the object move underneath it.
        parseJson<ReadJson>(
            await tool.execute({ action: "get", objectIds: [seeded.object_id] }, "call-get"),
        );
        tool.kernel.beforeCommit = () => tool.kernel.touch(seeded.object_id);
        const text = await tool.execute(
            { action: "revise", objectId: seeded.object_id, content: "Moved." },
            "call-revise-conflict",
        );
        expect(text).toBe(
            "Error: The object changed since it was read; read it again before writing. Re-read mem_seeded with ctx_memory get, then retry.",
        );
    });

    test("revise of an object seen only in m[0] re-reads then succeeds", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({ object_id: "mem_injected", decision_kind: "NAMING", summary: "N." });
        const tool = harness(kernel);
        // No prior tool read: the token cache is empty for this object.
        expect(tool.tokens.get(ROOT, "mem_injected")).toBeUndefined();
        const revised = parseJson<CommitJson>(
            await tool.execute(
                { action: "revise", objectId: "mem_injected", content: "Renamed." },
                "call-revise-m0",
            ),
        );
        expect(revised.outcome).toBe("applied");
        expect(tool.transport.methods()).toEqual(["kernel.read", "kernel.commit"]);
    });

    test("a duplicate create on the same tool call replays and creates no second object", async () => {
        const tool = harness();
        const args = createArgs("Replay exact bytes.");
        const first = parseJson<CommitJson>(await tool.execute(args, "call-replay"));
        const second = parseJson<CommitJson>(await tool.execute(args, "call-replay"));
        expect(first.outcome).toBe("applied");
        expect(second).toMatchObject({ outcome: "already applied", objects: first.objects });
        expect(tool.kernel.liveRows()).toHaveLength(1);
        // Changed arguments under the same tool call retain the operation key
        // and change the request digest, so the daemon rejects the redelivery
        // instead of committing a second operation.
        expect(await tool.execute(createArgs("Changed args."), "call-replay")).toBe(
            "Error: The operation key was reused with a different request digest.",
        );
        expect(tool.kernel.liveRows()).toHaveLength(1);
    });
});

describe("ctx_memory reads", () => {
    test("get returns typed memories and reports missing ids; list is dreamer-only", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: "mem_a",
            decision_kind: "ARCHITECTURE",
            summary: "A.",
            labeled: true,
        });
        kernel.seedDecision({ object_id: "mem_b", decision_kind: "NAMING", summary: "B." });
        const tool = harness(kernel);
        const got = parseJson<ReadJson>(
            await tool.execute({ action: "get", objectIds: ["mem_a", "mem_missing"] }, "call-get"),
        );
        expect(got.memories).toEqual([
            expect.objectContaining({
                objectId: "mem_a",
                category: "ARCHITECTURE",
                content: "A.",
                labeled: true,
            }),
        ]);
        expect(got.missingObjectIds).toEqual(["mem_missing"]);
        const read = tool.transport.calls[0]?.body as { surface: string; gated: boolean };
        expect(read).toMatchObject({ surface: "explicit_search", gated: false });

        expect(await tool.execute({ action: "list" }, "call-list-primary")).toContain(
            "not allowed",
        );
        const listed = parseJson<ReadJson>(
            await tool.execute({ action: "list", category: "NAMING" }, "call-list", DREAMER_AGENT),
        );
        expect(listed.memories.map((memory) => memory.objectId)).toEqual(["mem_b"]);
    });

    test("get with more than 20 unique ids is rejected naming the limit", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({ object_id: "mem_a", decision_kind: "ARCHITECTURE", summary: "A." });
        const tool = harness(kernel);
        const objectIds = Array.from({ length: 21 }, (_, index) => `mem_over_${index}`);
        expect(await tool.execute({ action: "get", objectIds }, "call-get-over")).toBe(
            "Error: get accepts at most 20 objectIds; 21 were given. Split the request.",
        );
        // Duplicates collapse before the limit check, so 21 entries with 20 unique ids pass.
        const got = parseJson<ReadJson>(
            await tool.execute(
                {
                    action: "get",
                    objectIds: [...objectIds.slice(0, 20), "mem_over_0"],
                },
                "call-get-dedup",
            ),
        );
        expect(got.missingObjectIds).toHaveLength(20);
    });

    test("a stale read renders the state text", async () => {
        const kernel = new FakeKernel();
        kernel.surfaceStates.set("explicit_search", {
            kind: "stale",
            lag_positions: 3,
            oldest_unconsumed_age_ms: 10,
        });
        const tool = harness(kernel);
        expect(await tool.execute({ action: "get", objectIds: ["mem_a"] }, "call-get")).toBe(
            "Error: Memory results may lag recent changes; the projector has not caught up.",
        );
    });
});

describe("ctx_memory lifecycle and merge", () => {
    test("archive retires and merge folds two into one", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({ object_id: "mem_a", decision_kind: "ARCHITECTURE", summary: "A." });
        kernel.seedDecision({ object_id: "mem_b", decision_kind: "ARCHITECTURE", summary: "B." });
        kernel.seedDecision({ object_id: "mem_c", decision_kind: "ARCHITECTURE", summary: "C." });
        const tool = harness(kernel);
        const archived = parseJson<CommitJson>(
            await tool.execute(
                { action: "archive", objectId: "mem_a", reason: "obsolete" },
                "call-archive",
            ),
        );
        expect(archived.outcome).toBe("applied");
        expect(archived.objectId).toBeUndefined();
        expect(kernel.objects.get("mem_a")?.invalidated_commit_seq).not.toBeNull();

        const merged = parseJson<CommitJson>(
            await tool.execute(
                { action: "merge", objectIds: ["mem_b", "mem_c"], content: "B and C." },
                "call-merge",
            ),
        );
        expect(merged.outcome).toBe("applied");
        expect(merged.objects).toContain("mem_b");
        expect(merged.objects).toContain("mem_c");
        // The tool result names the merge survivor apart from the retired predecessors.
        expect(merged.objectId).toMatch(/^mem_[0-9a-f]{32}$/);
        expect(merged.objectId).not.toBe("mem_b");
        expect(merged.objectId).not.toBe("mem_c");
        expect(kernel.objects.get(merged.objectId as string)?.decision?.payload.summary).toBe(
            "B and C.",
        );
        expect(kernel.liveRows().map((row) => row.decision?.payload.summary)).toEqual(["B and C."]);
        expect(await tool.execute({ action: "merge", objectIds: ["only"] }, "call-merge-one")).toBe(
            "Error: merge requires at least two objectIds",
        );
    });

    test("archive persists the supplied reason in the commit cause", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({ object_id: "mem_a", decision_kind: "ARCHITECTURE", summary: "A." });
        kernel.seedDecision({ object_id: "mem_b", decision_kind: "ARCHITECTURE", summary: "B." });
        const tool = harness(kernel);
        await tool.execute(
            { action: "archive", objectId: "mem_a", reason: "superseded by ADR-7" },
            "call-archive-reason",
        );
        const withReason = tool.transport.calls.find((call) => call.method === "kernel.commit")
            ?.body as { intent: { cause: string } };
        expect(withReason.intent.cause).toBe("call-archive-reason reason: superseded by ADR-7");

        await tool.execute({ action: "archive", objectId: "mem_b" }, "call-archive-bare");
        const bare = tool.transport.calls.filter((call) => call.method === "kernel.commit")[1]
            ?.body as { intent: { cause: string } };
        expect(bare.intent.cause).toBe("call-archive-bare");
    });

    test("an archive tool call redelivered against another target is rejected, not applied", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({ object_id: "mem_a", decision_kind: "ARCHITECTURE", summary: "A." });
        kernel.seedDecision({ object_id: "mem_b", decision_kind: "ARCHITECTURE", summary: "B." });
        const tool = harness(kernel);
        const first = parseJson<CommitJson>(
            await tool.execute({ action: "archive", objectId: "mem_a" }, "call-archive-redeliver"),
        );
        expect(first.outcome).toBe("applied");
        expect(
            await tool.execute({ action: "archive", objectId: "mem_b" }, "call-archive-redeliver"),
        ).toBe("Error: The operation key was reused with a different request digest.");
        expect(kernel.objects.get("mem_b")?.invalidated_commit_seq).toBeNull();
    });

    test("an archive redelivered with another target keeps its key regardless of the reason text", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({ object_id: "mem_a", decision_kind: "ARCHITECTURE", summary: "A." });
        kernel.seedDecision({ object_id: "mem_b", decision_kind: "ARCHITECTURE", summary: "B." });
        const tool = harness(kernel);
        const first = parseJson<CommitJson>(
            await tool.execute(
                { action: "archive", objectId: "mem_a", reason: "first delivery" },
                "call-archive-reason-swap",
            ),
        );
        expect(first.outcome).toBe("applied");
        // The reason is caller-controlled audit text and never enters the operation key, so a fresh reason cannot mint a fresh key. commentlint: allow(JUDGE)
        expect(
            await tool.execute(
                { action: "archive", objectId: "mem_b", reason: "second delivery" },
                "call-archive-reason-swap",
            ),
        ).toBe("Error: The operation key was reused with a different request digest.");
        expect(kernel.objects.get("mem_b")?.invalidated_commit_seq).toBeNull();
    });

    test("two sessions sharing a tool-call id commit as distinct operations", async () => {
        const tool = harness();
        const args = createArgs("Session-scoped operation keys.");
        const first = parseJson<CommitJson>(await tool.execute(args, "call-shared"));
        expect(first.outcome).toBe("applied");
        const otherSession = parseJson<CommitJson>(
            (await tool.definition.execute(
                { ...args, content: "A different fact from another session." } as never,
                {
                    sessionID: "ses-kernel-opencode-2",
                    directory: ROOT,
                    callID: "call-shared",
                    agent: "primary",
                } as never,
            )) as string,
        );
        expect(otherSession.outcome).toBe("applied");
        expect(otherSession.objectId).not.toBe(first.objectId);
        expect(tool.kernel.liveRows()).toHaveLength(2);
    });

    test("a target the project cannot read is refused before any commit", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({ object_id: "mem_a", decision_kind: "ARCHITECTURE", summary: "A." });
        kernel.seedDecision({
            object_id: "mem_secret",
            decision_kind: "ARCHITECTURE",
            summary: "S.",
            sensitivity: "secret",
        });
        const tool = harness(kernel);
        const refused = "Error: memory not found or not visible from this project: mem_secret";
        expect(
            await tool.execute({ action: "archive", objectId: "mem_secret" }, "call-archive-x"),
        ).toBe(refused);
        expect(
            await tool.execute(
                { action: "revise", objectId: "mem_secret", content: "S2." },
                "call-revise-x",
            ),
        ).toBe(refused);
        expect(
            await tool.execute(
                { action: "merge", objectIds: ["mem_a", "mem_secret"], content: "AS." },
                "call-merge-x",
            ),
        ).toBe(refused);
        expect(tool.transport.methods()).not.toContain("kernel.commit");
        expect(kernel.objects.get("mem_secret")?.invalidated_commit_seq).toBeNull();
    });
});

describe("ctx_memory merge category and sensitivity fences", () => {
    test("merge refuses predecessors from different categories before any commit", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({ object_id: "mem_a", decision_kind: "ARCHITECTURE", summary: "A." });
        kernel.seedDecision({ object_id: "mem_b", decision_kind: "CONSTRAINTS", summary: "B." });
        const tool = harness(kernel);
        expect(
            await tool.execute(
                { action: "merge", objectIds: ["mem_a", "mem_b"], content: "AB." },
                "call-merge-cross-category",
            ),
        ).toBe(
            "Error: merge targets span categories (ARCHITECTURE, CONSTRAINTS); one survivor cannot replace facts from different categories. Merge same-category memories only.",
        );
        expect(tool.transport.methods()).not.toContain("kernel.commit");
        expect(kernel.objects.get("mem_a")?.invalidated_commit_seq).toBeNull();
        expect(kernel.objects.get("mem_b")?.invalidated_commit_seq).toBeNull();
    });

    test("merge refuses folding anti-memories into a positive survivor", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: "mem_r1",
            decision_kind: "REJECTED_APPROACH",
            summary: "Trigger: retries. Rejected strategy: unbounded retry loop.",
        });
        kernel.seedDecision({
            object_id: "mem_r2",
            decision_kind: "REJECTED_APPROACH",
            summary: "Trigger: caching. Rejected strategy: cache without invalidation.",
        });
        const tool = harness(kernel);
        expect(
            await tool.execute(
                {
                    action: "merge",
                    objectIds: ["mem_r1", "mem_r2"],
                    category: "ARCHITECTURE",
                    content: "Do retries and caching.",
                },
                "call-merge-anti-to-positive",
            ),
        ).toBe(
            "Error: merge cannot fold REJECTED_APPROACH memories into a positive survivor; the negation would be lost",
        );
        expect(tool.transport.methods()).not.toContain("kernel.commit");
    });

    test("merge refuses folding positive memories into an anti-memory survivor", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({ object_id: "mem_a", decision_kind: "ARCHITECTURE", summary: "A." });
        kernel.seedDecision({ object_id: "mem_b", decision_kind: "ARCHITECTURE", summary: "B." });
        const tool = harness(kernel);
        expect(
            await tool.execute(
                {
                    action: "merge",
                    objectIds: ["mem_a", "mem_b"],
                    category: "REJECTED_APPROACH",
                    antiMemory: {
                        trigger: "merging",
                        rejectedStrategy: "merging positives",
                        rejectionReason: "positives are not rejections",
                    },
                },
                "call-merge-positive-to-anti",
            ),
        ).toBe("Error: merge cannot fold positive memories into an anti-memory survivor");
        expect(tool.transport.methods()).not.toContain("kernel.commit");
    });

    test("the merge survivor carries the strictest predecessor sensitivity", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({ object_id: "mem_a", decision_kind: "ARCHITECTURE", summary: "A." });
        kernel.seedDecision({
            object_id: "mem_b",
            decision_kind: "ARCHITECTURE",
            summary: "B.",
            sensitivity: "sensitive",
        });
        const tool = harness(kernel);
        const merged = parseJson<CommitJson>(
            await tool.execute(
                { action: "merge", objectIds: ["mem_a", "mem_b"], content: "A and B." },
                "call-merge-sensitive",
            ),
        );
        expect(merged.outcome).toBe("applied");
        expect(kernel.objects.get(merged.objectId as string)?.sensitivity).toBe("sensitive");
        const commit = tool.transport.calls.find((call) => call.method === "kernel.commit")
            ?.body as { operations: Array<{ spec: { sensitivity?: string } }> };
        expect(commit.operations.every((op) => op.spec.sensitivity === "sensitive")).toBeTrue();
    });

    test("revise inherits the predecessor's sensitivity instead of resetting to normal", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: "mem_s",
            decision_kind: "ARCHITECTURE",
            summary: "S.",
            sensitivity: "sensitive",
        });
        const tool = harness(kernel);
        const revised = parseJson<CommitJson>(
            await tool.execute(
                { action: "revise", objectId: "mem_s", content: "S2." },
                "call-revise-sensitive",
            ),
        );
        expect(revised.outcome).toBe("applied");
        expect(kernel.objects.get(revised.objectId as string)?.sensitivity).toBe("sensitive");
    });
});

describe("ctx_memory domain fence and lineage", () => {
    test("a decision outside the memory domain is invisible and cannot be archived", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: "mem_notes",
            decision_kind: "ARCHITECTURE",
            summary: "Notes.",
            domain_id: "notes",
        });
        const tool = harness(kernel);
        const got = parseJson<ReadJson>(
            await tool.execute({ action: "get", objectIds: ["mem_notes"] }, "call-get-domain"),
        );
        expect(got.memories).toEqual([]);
        expect(got.missingObjectIds).toEqual(["mem_notes"]);
        expect(
            await tool.execute({ action: "archive", objectId: "mem_notes" }, "call-archive-domain"),
        ).toBe("Error: memory not found or not visible from this project: mem_notes");
        expect(tool.transport.methods()).not.toContain("kernel.commit");
        expect(kernel.objects.get("mem_notes")?.invalidated_commit_seq).toBeNull();
    });

    test("a memory-domain row with a legacy category reads and archives", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: "mem_legacy",
            decision_kind: "USER_DIRECTIVES",
            summary: "Legacy.",
            source_id: "claim-lane-import",
            source_kind: "model",
        });
        const tool = harness(kernel);
        const got = parseJson<ReadJson>(
            await tool.execute({ action: "get", objectIds: ["mem_legacy"] }, "call-get-legacy"),
        );
        expect(got.memories).toEqual([
            expect.objectContaining({ objectId: "mem_legacy", category: "USER_DIRECTIVES" }),
        ]);
        const archived = parseJson<CommitJson>(
            await tool.execute(
                { action: "archive", objectId: "mem_legacy" },
                "call-archive-legacy",
            ),
        );
        expect(archived.outcome).toBe("applied");
        expect(kernel.objects.get("mem_legacy")?.invalidated_commit_seq).not.toBeNull();
    });

    test("revise of a historian-promoted memory sends the predecessor's lineage", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: "mem_hist",
            decision_kind: "ARCHITECTURE",
            summary: "H.",
            source_id: "historian",
            source_kind: "model",
        });
        const tool = harness(kernel);
        const revised = parseJson<CommitJson>(
            await tool.execute(
                { action: "revise", objectId: "mem_hist", content: "H2." },
                "call-revise-hist",
            ),
        );
        expect(revised.outcome).toBe("applied");
        const survivor = revised.objects.find((id) => id !== "mem_hist") as string;
        const commit = tool.transport.calls.find((call) => call.method === "kernel.commit")
            ?.body as { source_kind?: string };
        expect(commit.source_kind).toBe("model");
        expect(kernel.objects.get(survivor)).toMatchObject({
            source_id: "historian",
            source_kind: "model",
            source_revision: 2,
        });
    });

    test("merge across differing lineages is refused before any commit", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: "mem_own",
            decision_kind: "ARCHITECTURE",
            summary: "O.",
        });
        kernel.seedDecision({
            object_id: "mem_hist",
            decision_kind: "ARCHITECTURE",
            summary: "H.",
            source_id: "historian",
            source_kind: "model",
        });
        const tool = harness(kernel);
        const text = await tool.execute(
            { action: "merge", objectIds: ["mem_own", "mem_hist"], content: "OH." },
            "call-merge-mixed",
        );
        expect(text).toContain("Merge same-lineage memories only");
        expect(tool.transport.methods()).not.toContain("kernel.commit");
        expect(kernel.liveRows()).toHaveLength(2);
    });

    test("a dreamer create commits under source kind dreamer", async () => {
        const tool = harness();
        const created = parseJson<CommitJson>(
            await tool.execute(createArgs("Dreamed."), "call-dreamer-create", DREAMER_AGENT),
        );
        const objectId = created.objects[0] as string;
        const commit = tool.transport.calls[0]?.body as { source_kind?: string };
        expect(commit.source_kind).toBe("dreamer");
        expect(tool.kernel.objects.get(objectId)?.source_kind).toBe("dreamer");
    });
});

describe("ctx_memory anti-memory", () => {
    test("create without an expiry defaults the anti-memory horizon and replays byte-identically", async () => {
        const tool = harness();
        const payload = {
            trigger: "Choosing a cache backend",
            rejectedStrategy: "Use Redis",
            rejectionReason: "The project must work offline",
        };
        const created = parseJson<CommitJson>(
            await tool.execute(
                { action: "create", category: "REJECTED_APPROACH", antiMemory: payload },
                "call-anti-ttl",
            ),
        );
        const objectId = created.objects[0] as string;
        const summary = tool.kernel.objects.get(objectId)?.decision?.payload.summary ?? "";
        const match = summary.match(/^Expires at: (\d+)$/m);
        expect(match).not.toBeNull();
        const expiresAt = Number(match?.[1]);
        const ninetyDays = 90 * 24 * 60 * 60 * 1_000;
        const day = 24 * 60 * 60 * 1_000;
        expect(expiresAt).toBeGreaterThanOrEqual(Date.now() + ninetyDays - day);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + ninetyDays + day);

        const replayed = parseJson<CommitJson>(
            await tool.execute(
                { action: "create", category: "REJECTED_APPROACH", antiMemory: payload },
                "call-anti-ttl",
            ),
        );
        expect(replayed.outcome).toBe("already applied");
        expect(tool.kernel.liveRows()).toHaveLength(1);
    });

    test("list omits an expired anti-memory while get by id still returns it", async () => {
        const tool = harness();
        const expired = {
            trigger: "Choosing a cache backend",
            rejectedStrategy: "Use Redis",
            rejectionReason: "The project must work offline",
            expiresAt: Date.now() - 1_000,
        };
        const created = parseJson<CommitJson>(
            await tool.execute(
                reduced({ action: "create", category: "REJECTED_APPROACH", antiMemory: expired }),
                "call-anti-expired",
            ),
        );
        const objectId = created.objects[0] as string;
        const listed = parseJson<ReadJson>(
            await tool.execute({ action: "list" }, "call-anti-expired-list", DREAMER_AGENT),
        );
        expect(listed.memories).toHaveLength(0);
        const got = parseJson<ReadJson>(
            await tool.execute({ action: "get", objectIds: [objectId] }, "call-anti-expired-get"),
        );
        expect(got.memories).toHaveLength(1);
    });

    test("creates typed anti-memory, reads it back parsed, and rejects cross-arm shapes", async () => {
        const tool = harness();
        const payload = {
            trigger: "Choosing a cache backend",
            rejectedStrategy: "Use Redis",
            rejectionReason: "The project must work offline",
            saferAlternative: "Use SQLite",
        };
        const created = parseJson<CommitJson>(
            await tool.execute(
                reduced({ action: "create", category: "REJECTED_APPROACH", antiMemory: payload }),
                "call-anti-create",
            ),
        );
        const objectId = created.objects[0] as string;
        const got = parseJson<ReadJson>(
            await tool.execute({ action: "get", objectIds: [objectId] }, "call-anti-get"),
        );
        expect(got.memories[0]).toMatchObject({
            category: "REJECTED_APPROACH",
            antiMemory: expect.objectContaining(payload),
        });
        for (const [callId, args] of [
            ["call-anti-missing", { action: "create", category: "REJECTED_APPROACH" }],
            [
                "call-positive-payload",
                { action: "create", category: "ARCHITECTURE", content: "p", antiMemory: payload },
            ],
            ["call-bad-category", { action: "create", category: "arbitrary", content: "x" }],
        ] as const) {
            expect(await tool.execute(args, callId)).toContain("Error:");
        }
        expect(tool.kernel.liveRows()).toHaveLength(1);
    });

    test("revise of an anti-memory without a replacement inherits the parsed payload", async () => {
        const tool = harness();
        const payload = {
            trigger: "Choosing a cache backend",
            rejectedStrategy: "Use Redis",
            rejectionReason: "The project must work offline",
        };
        const created = parseJson<CommitJson>(
            await tool.execute(
                { action: "create", category: "REJECTED_APPROACH", antiMemory: payload },
                "call-anti-create-revise",
            ),
        );
        const objectId = created.objects[0] as string;
        const revised = parseJson<CommitJson>(
            await tool.execute(
                { action: "revise", objectId, reason: "still true" },
                "call-anti-revise",
            ),
        );
        expect(revised.outcome).toBe("applied");
        const survivor = revised.objectId as string;
        const got = parseJson<ReadJson>(
            await tool.execute({ action: "get", objectIds: [survivor] }, "call-anti-revise-get"),
        );
        expect(got.memories[0]).toMatchObject({
            category: "REJECTED_APPROACH",
            antiMemory: expect.objectContaining(payload),
        });
    });

    test("revise of an anti-memory whose summary does not parse names the input error", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: "mem_anti_broken",
            decision_kind: "REJECTED_APPROACH",
            summary: "free prose that is not an anti-memory payload",
        });
        const tool = harness(kernel);
        const text = await tool.execute(
            { action: "revise", objectId: "mem_anti_broken" },
            "call-anti-broken",
        );
        expect(text).toBe(
            "Error: the anti-memory being replaced has an unparseable stored payload; pass a full antiMemory payload to replace it",
        );
        expect(kernel.objects.get("mem_anti_broken")?.invalidated_commit_seq).toBeNull();
    });

    test("merge inherits from the caller's first target, not store order", async () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: "mem_first_in_store",
            decision_kind: "ARCHITECTURE",
            summary: "Stored earlier.",
        });
        kernel.seedDecision({
            object_id: "mem_second_in_store",
            decision_kind: "ARCHITECTURE",
            summary: "Stored later.",
            rationale: "why",
        });
        const tool = harness(kernel);
        const merged = parseJson<CommitJson>(
            await tool.execute(
                { action: "merge", objectIds: ["mem_second_in_store", "mem_first_in_store"] },
                "call-merge-order",
            ),
        );
        const survivor = kernel.objects.get(merged.objectId as string);
        expect(survivor?.decision?.decision_kind).toBe("ARCHITECTURE");
        expect(survivor?.decision?.payload.summary).toBe("Stored later.");
        expect(survivor?.decision?.payload.rationale).toBe("why");
    });
});

describe("ctx_memory human authority", () => {
    test("agent approve and enforce actions are rejected", async () => {
        const tool = harness();
        expect(await tool.execute({ action: "approve" }, "call-approve")).toContain(
            "human-host-owned",
        );
        expect(await tool.execute({ action: "enforce" }, "call-enforce")).toContain(
            "human-host-owned",
        );
        expect(await tool.execute({ action: "delete" }, "call-delete", DREAMER_AGENT)).toContain(
            "not allowed",
        );
    });
});

/** Every OpenCode file on the memory path; the text bans below scan this list. */
export const OPENCODE_MEMORY_PATH_FILES = [
    "tools/ctx-memory/tools.ts",
    "tools/ctx-memory/types.ts",
    "tools/ctx-memory/constants.ts",
    "tools/ctx-memory/write-shape.ts",
    "tools/ctx-search/tools.ts",
    "hooks/magic-context/kernel-transport.ts",
    "hooks/magic-context/kernel-memory-render.ts",
    "hooks/magic-context/inject-compartments.ts",
    "hooks/magic-context/transform.ts",
    "hooks/magic-context/transform-compartment-phase.ts",
    "hooks/magic-context/m0-token-breakdown.ts",
    "hooks/magic-context/auto-search-runner.ts",
    "plugin/rpc-handlers.ts",
    "plugin/tool-registry.ts",
];

/** Every Pi file on the memory path, relative to `packages/pi-plugin/src`; the same bans scan it. */
export const PI_MEMORY_PATH_FILES = [
    "tools/ctx-memory.ts",
    "tools/ctx-search.ts",
    "tools/index.ts",
    "kernel-client-pi.ts",
    "inject-compartments-pi.ts",
    "context-handler.ts",
    "auto-search-pi.ts",
    "dialogs/status-dialog.ts",
    "commands/ctx-status.ts",
    "clone-inheritance.ts",
    "pi-historian-runner.ts",
];

const TEXT_BANS = ["claim.intent", "authorityState", "rustToolBackends.memory"];

/**
 * `hook.ts` keeps `authorityState` for the notes domain, so it is scanned only
 * for the memory backend and the claim-intent protocol it used to drive.
 */
const HOOK_TEXT_BANS = ["claim.intent", "rustToolBackends.memory", "commitModuleClaimIntent"];

function scanForBans(
    sources: ReadonlyMap<string, string>,
    bans: readonly string[] = TEXT_BANS,
): string[] {
    const hits: string[] = [];
    for (const [file, source] of sources) {
        for (const ban of bans) {
            if (source.includes(ban)) hits.push(`${file}: ${ban}`);
        }
    }
    return hits;
}

describe("ctx_memory memory path text bans", () => {
    test("no memory-path file names the claim lane, authority state, or the Rust memory backend", () => {
        const sources = new Map<string, string>();
        for (const file of OPENCODE_MEMORY_PATH_FILES) {
            sources.set(file, readFileSync(resolve(import.meta.dir, "../..", file), "utf8"));
        }
        expect(scanForBans(sources)).toEqual([]);
    });

    test("no Pi memory-path file names the claim lane, authority state, or the Rust memory backend", () => {
        const sources = new Map<string, string>();
        for (const file of PI_MEMORY_PATH_FILES) {
            sources.set(
                `pi-plugin/${file}`,
                readFileSync(resolve(import.meta.dir, "../../../../pi-plugin/src", file), "utf8"),
            );
        }
        expect(scanForBans(sources)).toEqual([]);
    });

    test("the hook wires no Rust memory backend", () => {
        const file = "hooks/magic-context/hook.ts";
        const sources = new Map([
            [file, readFileSync(resolve(import.meta.dir, "../..", file), "utf8")],
        ]);
        expect(scanForBans(sources, HOOK_TEXT_BANS)).toEqual([]);
    });

    test("the scan fails on an injected authorityState reference", () => {
        const sources = new Map<string, string>([
            ["injected.ts", "const state = await backends.authorityState({});"],
        ]);
        expect(scanForBans(sources)).toEqual(["injected.ts: authorityState"]);
    });

    test("tool sources contain no legacy IDs, embeddings, or mutation-log writes", () => {
        const files = [
            resolve(import.meta.dir, "constants.ts"),
            resolve(import.meta.dir, "tools.ts"),
            resolve(import.meta.dir, "types.ts"),
            resolve(import.meta.dir, "../../plugin/tool-registry.ts"),
        ];
        const forbidden = [
            "memory_embeddings",
            "memory_mutation_log",
            "storage-memory-claims",
            'storage-memory"',
            "memoryId",
            "projectId: effect.projectId",
        ];
        for (const file of files) {
            const source = readFileSync(file, "utf8");
            for (const value of forbidden) expect(source).not.toContain(value);
        }
    });
});
