import { describe, expect, test } from "bun:test";
import { createProjectMemoryClaim } from "../../features/magic-context/memory/storage-claim-operations";
import { ensureProject } from "../../features/magic-context/memory/storage-claims";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import { KernelClient } from "../../shared/kernel-client";
import { FakeKernel, FakeKernelTransport } from "../../shared/kernel-client-testing/fake-kernel";
import type { Database } from "../../shared/sqlite";
import {
    CLAIM_LANE_IMPORT_SOURCE_ID,
    claimLaneImportDone,
    importClaimLaneMemories,
    importedObjectId,
    listClaimLaneMemories,
} from "./claim-lane-import";

const PROJECT = "git:import-project";
const OTHER_PROJECT = "git:other-project";

function seedClaim(db: Database, project: string, key: string, content: string): string {
    const projectId = ensureProject(db, project);
    const result = createProjectMemoryClaim(
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
    return (result.result.payload as { claim: { publicClaimId: string } }).claim.publicClaimId;
}

function harness() {
    const db = createDirectTestDatabase({ path: ":memory:" }).db;
    const kernel = new FakeKernel();
    const transport = new FakeKernelTransport(kernel);
    const client = new KernelClient({
        transport,
        enabled: true,
        sessionId: "s1",
        projectRoot: "/repo/import",
    });
    return { db, kernel, transport, client };
}

describe("claim-lane import", () => {
    test("lists only the project's own active claims", () => {
        const { db } = harness();
        seedClaim(db, PROJECT, "a", "Own claim A.");
        seedClaim(db, OTHER_PROJECT, "b", "Foreign claim B.");
        const listed = listClaimLaneMemories(db, PROJECT);
        expect(listed.map((claim) => claim.content)).toEqual(["Own claim A."]);
    });

    test("imports once, marks the project done, and replays cleanly", async () => {
        const { db, kernel, transport, client } = harness();
        const first = seedClaim(db, PROJECT, "a", "Own claim A.");
        const second = seedClaim(db, PROJECT, "b", "Own claim B.");

        expect(
            await importClaimLaneMemories({ db, client, projectPath: PROJECT, sessionId: "s1" }),
        ).toBe("done");
        expect(claimLaneImportDone(db, PROJECT)).toBe(true);
        const live = kernel.liveRows();
        expect(live.map((row) => row.object_id).sort()).toEqual(
            [importedObjectId(first), importedObjectId(second)].sort(),
        );
        expect(live.every((row) => row.source_id === CLAIM_LANE_IMPORT_SOURCE_ID)).toBe(true);
        expect(live.every((row) => row.source_kind === "model")).toBe(true);

        const commitsBefore = transport.methods().filter((m) => m === "kernel.commit").length;
        expect(
            await importClaimLaneMemories({ db, client, projectPath: PROJECT, sessionId: "s1" }),
        ).toBe("skipped");
        expect(transport.methods().filter((m) => m === "kernel.commit").length).toBe(commitsBefore);
    });

    test("a partial earlier run resumes without re-inserting present objects", async () => {
        const { db, kernel, client } = harness();
        const first = seedClaim(db, PROJECT, "a", "Own claim A.");
        seedClaim(db, PROJECT, "b", "Own claim B.");
        kernel.seedDecision({
            object_id: importedObjectId(first),
            decision_kind: "ARCHITECTURE",
            summary: "Own claim A.",
        });
        expect(
            await importClaimLaneMemories({ db, client, projectPath: PROJECT, sessionId: "s1" }),
        ).toBe("done");
        expect(kernel.liveRows()).toHaveLength(2);
    });

    test("an unavailable kernel defers and leaves the marker unset", async () => {
        const { db, kernel, client } = harness();
        seedClaim(db, PROJECT, "a", "Own claim A.");
        kernel.surfaceStates.set("explicit_search", {
            kind: "unavailable",
            reason: "store_starting",
        });
        expect(
            await importClaimLaneMemories({ db, client, projectPath: PROJECT, sessionId: "s1" }),
        ).toBe("deferred");
        expect(claimLaneImportDone(db, PROJECT)).toBe(false);
        expect(kernel.liveRows()).toHaveLength(0);
    });

    test("a project with no claims is marked done without dialing the daemon", async () => {
        const { db, transport, client } = harness();
        expect(
            await importClaimLaneMemories({ db, client, projectPath: PROJECT, sessionId: "s1" }),
        ).toBe("done");
        expect(transport.calls).toHaveLength(0);
        expect(claimLaneImportDone(db, PROJECT)).toBe(true);
    });
});
