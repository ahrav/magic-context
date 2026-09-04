import { describe, expect, test } from "bun:test";
import { ANTI_MEMORY_CATEGORY } from "../../features/magic-context/memory/constants";
import {
    BUDGET_OMITTED_MARKER,
    EMPTY_PROJECT_MARKER,
    KernelClient,
    type KernelClientResolver,
} from "../../shared/kernel-client";
import { FakeKernel, FakeKernelTransport } from "../../shared/kernel-client-testing/fake-kernel";
import {
    memoryRows,
    readHistorianMemoryBlock,
    readInjectionMemorySnapshot,
    renderKernelMemoryBlock,
    trimKernelRowsToBudget,
    withoutSensitiveRows,
} from "./kernel-memory-render";

const SESSION = "ses-kernel-render";
const PROJECT = "git:kernel-render";

/** A kernel client over an in-memory fake; the resolver shape matches the transform's. */
function kernelHarness(kernel = new FakeKernel()): {
    kernel: FakeKernel;
    client: KernelClient;
    kernelClient: KernelClientResolver;
    transport: FakeKernelTransport;
} {
    const transport = new FakeKernelTransport(kernel);
    const kernelClient: KernelClientResolver = ({ sessionId, projectRoot }) =>
        new KernelClient({ transport, enabled: true, sessionId, projectRoot });
    return {
        kernel,
        client: kernelClient({ sessionId: SESSION, projectRoot: PROJECT }),
        kernelClient,
        transport,
    };
}

function seededKernel(
    rows: { id: string; summary: string; sensitivity?: "normal" | "sensitive" | "secret" }[],
): FakeKernel {
    const kernel = new FakeKernel();
    for (const row of rows) {
        kernel.seedDecision({
            object_id: `mem_${row.id.repeat(32).slice(0, 32)}`,
            decision_kind: "PROJECT_RULES",
            summary: row.summary,
            sensitivity: row.sensitivity,
        });
    }
    return kernel;
}

describe("renderKernelMemoryBlock markers", () => {
    test("rows all trimmed by the budget render the budget-omitted marker, not empty-project", () => {
        const kernel = seededKernel([{ id: "a", summary: "always run focused tests" }]);
        const snapshot = kernel.snapshot();
        const rows = memoryRows(snapshot);
        const trimmed = trimKernelRowsToBudget(rows, 0);
        expect(trimmed).toEqual([]);

        const block = renderKernelMemoryBlock(trimmed, snapshot.state, rows.length);
        expect(block).toContain(BUDGET_OMITTED_MARKER);
        expect(block).not.toContain(EMPTY_PROJECT_MARKER);
    });

    test("a truly empty available snapshot still renders the empty-project marker", () => {
        const snapshot = new FakeKernel().snapshot();
        const rows = memoryRows(snapshot);
        const block = renderKernelMemoryBlock(rows, snapshot.state, rows.length);
        expect(block).toContain(EMPTY_PROJECT_MARKER);
        expect(block).not.toContain(BUDGET_OMITTED_MARKER);
    });
});

describe("sensitivity filtering on automatic surfaces", () => {
    const seeds = [
        { id: "a", summary: "a normal memory", sensitivity: "normal" as const },
        { id: "b", summary: "a sensitive memory", sensitivity: "sensitive" as const },
    ];

    test("withoutSensitiveRows drops sensitive rows and keeps the rest", () => {
        const snapshot = seededKernel(seeds).snapshot();
        expect(snapshot.rows).toHaveLength(2);
        const filtered = withoutSensitiveRows(snapshot);
        expect(filtered.rows.map((row) => row.object.sensitivity)).toEqual(["normal"]);
        expect(filtered.state).toEqual(snapshot.state);
    });

    test("the injection snapshot excludes sensitive rows while normal rows pass", async () => {
        const { kernelClient } = kernelHarness(seededKernel(seeds));
        const snapshot = await readInjectionMemorySnapshot({
            kernelClient,
            memoryEnabled: true,
            projectIdentity: PROJECT,
            sessionId: SESSION,
            projectRoot: PROJECT,
        });
        expect(snapshot.state.kind).toBe("available");
        const summaries = memoryRows(snapshot).map((row) => row.decision?.payload.summary);
        expect(summaries).toEqual(["a normal memory"]);
    });

    test("the historian baseline excludes sensitive rows while normal rows pass", async () => {
        const { client } = kernelHarness(seededKernel(seeds));
        const block = await readHistorianMemoryBlock({ client, sessionId: SESSION });
        expect(block).toContain("a normal memory");
        expect(block).not.toContain("a sensitive memory");
    });
});

describe("domain fence on rendered rows", () => {
    test("memoryRows keeps only memory-domain decision rows", () => {
        const kernel = seededKernel([{ id: "a", summary: "a memory-domain row" }]);
        kernel.seedDecision({
            object_id: `mem_${"c".repeat(32)}`,
            decision_kind: "PROJECT_RULES",
            summary: "a foreign-domain decision",
            domain_id: "notes",
        });
        const snapshot = kernel.snapshot();
        expect(snapshot.rows).toHaveLength(2);
        const rows = memoryRows(snapshot);
        expect(rows.map((row) => row.decision?.payload.summary)).toEqual(["a memory-domain row"]);
    });
});

describe("anti-memory fence on automatic surfaces", () => {
    function kernelWithAntiMemory(): FakeKernel {
        const kernel = seededKernel([{ id: "a", summary: "a positive memory" }]);
        kernel.seedDecision({
            object_id: `mem_${"d".repeat(32)}`,
            decision_kind: ANTI_MEMORY_CATEGORY,
            summary: "Trigger: retries. Rejected strategy: unbounded retry loop.",
        });
        return kernel;
    }

    test("memoryRows excludes anti-memory rows while the snapshot keeps them", () => {
        const kernel = kernelWithAntiMemory();
        const snapshot = kernel.snapshot();
        expect(snapshot.rows).toHaveLength(2);
        const rows = memoryRows(snapshot);
        expect(rows.map((row) => row.decision?.payload.summary)).toEqual(["a positive memory"]);
    });

    test("the historian baseline omits anti-memory rows", async () => {
        const { client } = kernelHarness(kernelWithAntiMemory());
        const block = await readHistorianMemoryBlock({ client, sessionId: SESSION });
        expect(block).toContain("a positive memory");
        expect(block).not.toContain("unbounded retry loop");
    });
});

describe("serving-policy gating on automatic reads", () => {
    test("the injection read is gated and a stale answer becomes abstained with no rows", async () => {
        const { kernel, kernelClient, transport } = kernelHarness(
            seededKernel([{ id: "a", summary: "a memory" }]),
        );
        kernel.surfaceStates.set("explicit_search", {
            kind: "stale",
            lag_positions: 12,
            oldest_unconsumed_age_ms: 90_000,
        });
        const snapshot = await readInjectionMemorySnapshot({
            kernelClient,
            memoryEnabled: true,
            projectIdentity: PROJECT,
            sessionId: SESSION,
            projectRoot: PROJECT,
        });
        expect(transport.calls[0]?.body).toMatchObject({ gated: true });
        expect(snapshot.state).toEqual({
            kind: "abstained",
            lag_positions: 12,
            oldest_unconsumed_age_ms: 90_000,
        });
        expect(snapshot.rows).toEqual([]);
    });

    test("the historian read is gated and a stale answer yields no baseline", async () => {
        const kernel = seededKernel([{ id: "a", summary: "a memory" }]);
        kernel.surfaceStates.set("explicit_search", {
            kind: "stale",
            lag_positions: 1,
            oldest_unconsumed_age_ms: 60_000,
        });
        const { client, transport } = kernelHarness(kernel);
        const block = await readHistorianMemoryBlock({ client, sessionId: SESSION });
        expect(transport.calls[0]?.body).toMatchObject({ gated: true });
        expect(block).toBe("");
    });
});

describe("category tag safety", () => {
    test("a taxonomy category renders as its own element", () => {
        const kernel = seededKernel([{ id: "a", summary: "always run focused tests" }]);
        const snapshot = kernel.snapshot();
        const block = renderKernelMemoryBlock(memoryRows(snapshot), snapshot.state);
        expect(block).toContain("<PROJECT_RULES>");
        expect(block).toContain("</PROJECT_RULES>");
    });

    test("a decision kind that is not a legal XML name rides as an escaped attribute", () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: `mem_${"e".repeat(32)}`,
            decision_kind: 'build rules/<"legacy">',
            summary: "a legacy-kind memory",
        });
        const snapshot = kernel.snapshot();
        const block = renderKernelMemoryBlock(memoryRows(snapshot), snapshot.state);
        expect(block).toContain('<memory-category name="build rules/&lt;&quot;legacy&quot;&gt;">');
        expect(block).toContain("</memory-category>");
        expect(block).not.toContain("<build rules");
        expect(block).toContain("a legacy-kind memory");
    });

    test("trimming budgets the safe tag form for an illegal-name category", () => {
        const kernel = new FakeKernel();
        kernel.seedDecision({
            object_id: `mem_${"f".repeat(32)}`,
            decision_kind: "build rules",
            summary: "a legacy-kind memory",
        });
        const rows = memoryRows(kernel.snapshot());
        expect(trimKernelRowsToBudget(rows, 0)).toEqual([]);
        expect(trimKernelRowsToBudget(rows, 10_000)).toEqual(rows);
    });
});
