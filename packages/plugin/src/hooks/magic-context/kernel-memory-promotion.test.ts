import { describe, expect, test } from "bun:test";
import type {
    HistorianPromotionIdentity,
    PromotedMemoryRef,
} from "../../features/magic-context/memory/promotion";
import { KernelClient } from "../../shared/kernel-client";
import { FakeKernel, FakeKernelTransport } from "../../shared/kernel-client-testing/fake-kernel";
import { commitPromotedFactsToKernel, promotedFactSpecs } from "./kernel-memory-promotion";

const identity: HistorianPromotionIdentity = {
    producer: "test-historian",
    runId: "s1:0:9",
    leaseKey: "compartment:s1",
    leaseGeneration: 1,
    batchId: "0-9",
};

function ref(category: string, content: string): PromotedMemoryRef {
    return {
        publicClaimId: `mcm_${content}`,
        revisionLocator: "r1",
        contentDigest: `digest-${content}`,
        content,
        category,
    };
}

describe("historian kernel promotion", () => {
    test("specs derive stable ids and skip refs without a category or content", () => {
        const refs = [ref("PROJECT_RULES", "a"), ref("", "b"), ref("CONFIG_VALUES", "")];
        const first = promotedFactSpecs(refs, identity);
        const second = promotedFactSpecs(refs, identity);
        expect(first).toHaveLength(1);
        expect(first).toEqual(second);
        expect(first[0]?.object_id).toMatch(/^mem_[0-9a-f]{32}$/);
        expect(first[0]?.source_id).toBe("historian");
    });

    test("a rerun of the same batch replays instead of minting a second object", async () => {
        const kernel = new FakeKernel();
        const transport = new FakeKernelTransport(kernel);
        const client = new KernelClient({
            transport,
            enabled: true,
            sessionId: "s1",
            projectRoot: "/repo",
        });
        const refs = [ref("PROJECT_RULES", "the build runs in CI only")];
        await commitPromotedFactsToKernel({ client, sessionId: "s1", refs, identity });
        await commitPromotedFactsToKernel({ client, sessionId: "s1", refs, identity });
        expect(kernel.liveRows()).toHaveLength(1);
        expect(kernel.liveRows()[0]?.decision?.payload.summary).toBe("the build runs in CI only");
        expect(kernel.liveRows()[0]?.source_kind).toBe("model");
        expect(transport.methods().filter((method) => method === "kernel.commit")).toHaveLength(2);
    });

    test("no client and no refs are both no-ops", async () => {
        await commitPromotedFactsToKernel({
            client: undefined,
            sessionId: "s1",
            refs: [],
            identity,
        });
        const kernel = new FakeKernel();
        const transport = new FakeKernelTransport(kernel);
        const client = new KernelClient({
            transport,
            enabled: true,
            sessionId: "s1",
            projectRoot: "/repo",
        });
        await commitPromotedFactsToKernel({ client, sessionId: "s1", refs: [], identity });
        expect(transport.calls).toHaveLength(0);
    });
});
