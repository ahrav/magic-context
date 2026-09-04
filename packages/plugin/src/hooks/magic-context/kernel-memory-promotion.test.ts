import { describe, expect, test } from "bun:test";
import type {
    HistorianPromotionIdentity,
    PromotedMemoryRef,
} from "../../features/magic-context/memory/promotion";
import { createProjectMemoryClaim } from "../../features/magic-context/memory/storage-claim-operations";
import { ensureProject } from "../../features/magic-context/memory/storage-claims";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import { KernelClient } from "../../shared/kernel-client";
import { FakeKernel, FakeKernelTransport } from "../../shared/kernel-client-testing/fake-kernel";
import type { Database } from "../../shared/sqlite";
import { claimLaneImportDone, importClaimLaneMemories } from "./claim-lane-import";
import { commitPromotedFactsToKernel, promotedFactSpecs } from "./kernel-memory-promotion";

const PROJECT = "git:promotion-project";

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

function seedClaim(db: Database, project: string, key: string, content: string): void {
    const projectId = ensureProject(db, project);
    createProjectMemoryClaim(
        db,
        { producer: "test", operationKey: `${project}:${key}` },
        {
            projectId,
            content,
            category: "ARCHITECTURE",
            provenance: {
                sourceLocator: "transcript://seed",
                sourceContent: content,
                extractor: "historian",
                extractorVersion: "2",
                extractorRunId: "run-1",
                independenceKey: `ik-${key}`,
                sourceTrustClass: "model_inference",
            },
            actor: "user:test",
        },
    );
}

function harness() {
    const db = createDirectTestDatabase({ path: ":memory:" }).db;
    const kernel = new FakeKernel();
    const transport = new FakeKernelTransport(kernel);
    const client = new KernelClient({
        transport,
        enabled: true,
        sessionId: "s1",
        projectRoot: "/repo",
    });
    return { db, kernel, transport, client };
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
        const { db, kernel, transport, client } = harness();
        const refs = [ref("PROJECT_RULES", "the build runs in CI only")];
        const args = { client, db, projectPath: PROJECT, sessionId: "s1", refs, identity };
        await commitPromotedFactsToKernel(args);
        await commitPromotedFactsToKernel(args);
        expect(kernel.liveRows()).toHaveLength(1);
        expect(kernel.liveRows()[0]?.decision?.payload.summary).toBe("the build runs in CI only");
        expect(kernel.liveRows()[0]?.source_kind).toBe("model");
        expect(transport.methods().filter((method) => method === "kernel.commit")).toHaveLength(2);
    });

    test("no client and no refs are both no-ops", async () => {
        const { db } = harness();
        await commitPromotedFactsToKernel({
            client: undefined,
            db,
            projectPath: PROJECT,
            sessionId: "s1",
            refs: [],
            identity,
        });
        const { kernel, transport, client } = harness();
        await commitPromotedFactsToKernel({
            client,
            db,
            projectPath: PROJECT,
            sessionId: "s1",
            refs: [],
            identity,
        });
        expect(kernel.liveRows()).toHaveLength(0);
        expect(transport.calls).toHaveLength(0);
    });

    test("a non-available answer resets the import marker and a later importer run lands the fact", async () => {
        const { db, kernel, client } = harness();
        expect(
            await importClaimLaneMemories({ db, client, projectPath: PROJECT, sessionId: "s1" }),
        ).toBe("done");
        expect(claimLaneImportDone(db, PROJECT)).toBe(true);

        seedClaim(db, PROJECT, "a", "The gateway retries twice.");
        kernel.nextCommitState = { kind: "unavailable", reason: "store_starting" };
        await commitPromotedFactsToKernel({
            client,
            db,
            projectPath: PROJECT,
            sessionId: "s1",
            refs: [ref("ARCHITECTURE", "The gateway retries twice.")],
            identity,
        });
        expect(claimLaneImportDone(db, PROJECT)).toBe(false);
        expect(kernel.liveRows()).toHaveLength(0);

        expect(
            await importClaimLaneMemories({ db, client, projectPath: PROJECT, sessionId: "s1" }),
        ).toBe("done");
        expect(claimLaneImportDone(db, PROJECT)).toBe(true);
        const live = kernel.liveRows();
        expect(live).toHaveLength(1);
        expect(live[0]?.decision?.payload.summary).toBe("The gateway retries twice.");
        expect(live[0]?.decision?.decision_kind).toBe("ARCHITECTURE");
    });

    test("a reset replay skips claims the historian already promoted under its own ids", async () => {
        const { db, kernel, client } = harness();
        expect(
            await importClaimLaneMemories({ db, client, projectPath: PROJECT, sessionId: "s1" }),
        ).toBe("done");

        seedClaim(db, PROJECT, "a", "Fact already promoted.");
        await commitPromotedFactsToKernel({
            client,
            db,
            projectPath: PROJECT,
            sessionId: "s1",
            refs: [ref("ARCHITECTURE", "Fact already promoted.")],
            identity,
        });
        expect(kernel.liveRows()).toHaveLength(1);

        seedClaim(db, PROJECT, "b", "Fact the kernel never saw.");
        kernel.nextCommitState = { kind: "unavailable", reason: "store_starting" };
        await commitPromotedFactsToKernel({
            client,
            db,
            projectPath: PROJECT,
            sessionId: "s1",
            refs: [ref("ARCHITECTURE", "Fact the kernel never saw.")],
            identity: { ...identity, batchId: "10-19" },
        });
        expect(claimLaneImportDone(db, PROJECT)).toBe(false);

        expect(
            await importClaimLaneMemories({ db, client, projectPath: PROJECT, sessionId: "s1" }),
        ).toBe("done");
        const summaries = kernel
            .liveRows()
            .map((row) => row.decision?.payload.summary)
            .sort();
        expect(summaries).toEqual(["Fact already promoted.", "Fact the kernel never saw."]);
    });
});
