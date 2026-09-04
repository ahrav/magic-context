import { describe, expect, test } from "bun:test";
import { KernelClient, type KernelTransportCall } from "../kernel-client";
import { FakeKernel, FakeKernelTransport, fakeProjectScopeId } from "./fake-kernel";
import commitAvailableCreate from "./fixtures/commit-available-create.json";
import commitAvailableMerge from "./fixtures/commit-available-merge.json";
import commitConflictAdvanced from "./fixtures/commit-conflict-known-as-of-advanced.json";
import commitInvalidAdmissionPolicy from "./fixtures/commit-invalid-admission-policy.json";
import commitInvalidAlreadyExists from "./fixtures/commit-invalid-already-exists.json";
import commitInvalidNotFound from "./fixtures/commit-invalid-not-found.json";
import commitInvalidProjectMismatch from "./fixtures/commit-invalid-project-mismatch.json";
import commitInvalidRevision from "./fixtures/commit-invalid-revision-not-advanced.json";
import readAutoInjectEmpty from "./fixtures/read-auto-inject-empty.json";
import readCrossProjectEmpty from "./fixtures/read-cross-project-empty.json";
import readExplicitLabeled from "./fixtures/read-explicit-search-labeled.json";

/**
 * Every fixture is a reply the `recorded_*` tests in
 * `crates/mc-module/tests/kernel_routes.rs` captured from the daemon after the
 * same steps this file drives against the fake. The daemon's store holds one
 * seeded domain commit before the plugin writes, so the fake starts at tip 1.
 */

const SEEDED_TIP = 1;
const PROJECT = "/tmp/contract-project";
const OTHER_PROJECT = "/tmp/contract-project-b";
const SESSION = "session-a";
/** The route test's `decision_spec(index)`. */
function decisionSpec(index: number) {
    return {
        decision_id: `decision-${index}`,
        object_id: `decision-object-${index}`,
        domain_id: "domain",
        decision_kind: "memory",
        payload: { summary: `decision ${index}`, rationale: `because ${index}` },
        source_id: "memory-lineage",
        source_revision: index,
    };
}
/** The route test's `wire_intent(key, ..)`: the key is the operation identity, the cause is audit text. */
function intent(operationId: string) {
    return { actor: "assistant", operationId, cause: "ctx_memory" };
}

/** Keeps the raw reply of every call so a test can compare it with the recorded daemon bytes. */
class RecordingTransport extends FakeKernelTransport {
    readonly replies: unknown[] = [];

    override async call(args: KernelTransportCall): Promise<unknown> {
        const reply = await super.call(args);
        this.replies.push(reply);
        return reply;
    }

    lastReply(): unknown {
        return this.replies[this.replies.length - 1];
    }
}

function harness() {
    const kernel = new FakeKernel();
    kernel.tip = SEEDED_TIP;
    const transport = new RecordingTransport(kernel);
    const client = (projectRoot = PROJECT, sessionId = SESSION) =>
        new KernelClient({ transport, enabled: true, sessionId, projectRoot });
    return { kernel, transport, client };
}

/** The daemon embeds the digest of a temporary root in `scope_id`; the fixture carries a placeholder. */
function withScopePlaceholder(reply: unknown): unknown {
    const body = reply as { rows: { scope_id: string }[] };
    return {
        ...body,
        rows: body.rows.map((row) => {
            expect(row.scope_id).toBe(fakeProjectScopeId(PROJECT));
            return { ...row, scope_id: "project:<digest>" };
        }),
    };
}

async function createDecisionOne(h: ReturnType<typeof harness>): Promise<void> {
    const created = await h.client().create(decisionSpec(1), intent("create"));
    expect(created.state).toEqual({ kind: "available" });
}

describe("FakeKernel matches the daemon replies recorded in kernel_routes.rs", () => {
    test("a create answers the receipt, its token, and an empty merged list", async () => {
        const h = harness();
        await createDecisionOne(h);
        expect(h.transport.lastReply()).toEqual(commitAvailableCreate);
    });

    test("a plugin write is labeled on explicit_search", async () => {
        const h = harness();
        await createDecisionOne(h);
        const read = await h.client().read({ surface: "explicit_search" });
        expect(read.state).toEqual({ kind: "available" });
        expect(withScopePlaceholder(h.transport.lastReply())).toEqual(readExplicitLabeled);
    });

    test("the same write is absent from auto_inject", async () => {
        const h = harness();
        await createDecisionOne(h);
        await h.client().read({ surface: "auto_inject" });
        expect(h.transport.lastReply()).toEqual(readAutoInjectEmpty);
    });

    test("another project reads an empty explicit_search", async () => {
        const h = harness();
        await createDecisionOne(h);
        await h.client(OTHER_PROJECT, "session-b").read({ surface: "explicit_search" });
        expect(h.transport.lastReply()).toEqual(readCrossProjectEmpty);
    });

    test("refused commits answer with the state alone", async () => {
        const h = harness();
        await createDecisionOne(h);
        const n = h.kernel.tip;
        const changed = await h
            .client()
            .revise("decision-object-1", decisionSpec(2), intent("change"));
        expect(changed.state).toEqual({ kind: "available" });

        const stale = await h.client().commit({
            ...intent("stale"),
            operations: [{ op: "retire_decision", object_id: "decision-object-2" }],
            tokens: [{ object_id: "decision-object-2", known_as_of: n }],
        });
        expect(stale).toEqual(commitConflictAdvanced);

        const missing = await h.client().commit({
            ...intent("supersede-missing"),
            operations: [
                {
                    op: "supersede_decision",
                    replaced_object_id: "never-written",
                    spec: decisionSpec(3),
                },
            ],
            tokens: [],
        });
        expect(missing).toEqual(commitInvalidNotFound);

        const notAdvanced = await h.client().commit({
            ...intent("supersede-same-revision"),
            operations: [
                {
                    op: "supersede_decision",
                    replaced_object_id: "decision-object-2",
                    spec: { ...decisionSpec(3), source_revision: 2 },
                },
            ],
            tokens: [],
        });
        expect(notAdvanced).toEqual(commitInvalidRevision);
    });

    test("a client-shaped merge names the survivor once in merged", async () => {
        const h = harness();
        const created = await h.client().commit({
            ...intent("create"),
            operations: [1, 2, 3].map((index) => ({
                op: "insert_decision" as const,
                spec: decisionSpec(index),
            })),
            tokens: [],
        });
        expect(created.state).toEqual({ kind: "available" });
        const merged = await h
            .client()
            .merge(
                ["decision-object-1", "decision-object-2", "decision-object-3"],
                decisionSpec(4),
                intent("merge"),
            );
        expect(merged.state).toEqual({ kind: "available" });
        expect(h.transport.lastReply()).toEqual(commitAvailableMerge);
        // The receipt replays with the same merged list; explicit empty tokens skip the client's refresh read of the now-superseded targets. commentlint: allow(JUDGE)
        await h.client().commit({
            ...intent("merge"),
            operations: ["decision-object-1", "decision-object-2", "decision-object-3"].map(
                (objectId) => ({
                    op: "supersede_decision" as const,
                    replaced_object_id: objectId,
                    spec: decisionSpec(4),
                }),
            ),
            tokens: [],
        });
        expect(h.transport.lastReply()).toEqual({
            ...commitAvailableMerge,
            receipt: { ...commitAvailableMerge.receipt, replayed: true },
        });
        expect(h.kernel.liveRows().map((row) => row.object_id)).toEqual(["decision-object-4"]);
        for (const predecessor of ["decision-object-1", "decision-object-2", "decision-object-3"]) {
            expect(h.kernel.objects.get(predecessor)?.superseded_by).toBe("decision-object-4");
        }
    });

    test("a fold into a survivor below the sensitivity floor is admission_policy", async () => {
        const h = harness();
        const created = await h.client().commit({
            ...intent("create"),
            operations: [
                {
                    op: "insert_decision",
                    spec: { ...decisionSpec(1), sensitivity: "sensitive" },
                },
                { op: "insert_decision", spec: decisionSpec(2) },
            ],
            tokens: [],
        });
        expect(created.state).toEqual({ kind: "available" });
        const tip = h.kernel.tip;
        const laundered = await h
            .client()
            .revise("decision-object-1", decisionSpec(2), intent("fold-down"));
        expect(laundered).toEqual(commitInvalidAdmissionPolicy);
        expect(h.kernel.tip).toBe(tip);
    });

    test("a supersede into a retired in-project id is already_exists", async () => {
        const h = harness();
        const created = await h.client().commit({
            ...intent("create"),
            operations: [
                { op: "insert_decision", spec: decisionSpec(1) },
                { op: "insert_decision", spec: decisionSpec(2) },
            ],
            tokens: [],
        });
        expect(created.state).toEqual({ kind: "available" });
        const retired = await h.client().archive("decision-object-2", intent("retire"));
        expect(retired.state).toEqual({ kind: "available" });
        const tip = h.kernel.tip;
        const duplicate = await h
            .client()
            .revise("decision-object-1", decisionSpec(2), intent("supersede-retired"));
        expect(duplicate).toEqual(commitInvalidAlreadyExists);
        expect(h.kernel.tip).toBe(tip);
    });

    test("a body project_root other than the bound root is project_mismatch", async () => {
        const h = harness();
        const tip = h.kernel.tip;
        // The client always mirrors its bound root into the body, so the mismatch is driven through the transport directly. commentlint: allow(JUDGE)
        const reply = await h.transport.call({
            sessionId: SESSION,
            projectRoot: PROJECT,
            method: "kernel.commit",
            body: {
                method: "kernel.commit",
                v: 1,
                session_id: SESSION,
                project_root: OTHER_PROJECT,
                intent: {
                    producer: "plugin",
                    operation_key: "foreign",
                    request_digest: "foreign",
                    actor: "assistant",
                    cause: "ctx_memory",
                },
                tokens: [],
                operations: [{ op: "insert_decision", spec: decisionSpec(1) }],
                source_kind: "assistant",
            },
        });
        expect(reply).toEqual(commitInvalidProjectMismatch);
        expect(h.kernel.tip).toBe(tip);
        expect(h.kernel.objects.size).toBe(0);
    });
});
