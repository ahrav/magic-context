import { describe, expect, test } from "bun:test";
import { createProjectMemoryClaim } from "../../features/magic-context/memory/storage-claim-operations";
import { ensureProject } from "../../features/magic-context/memory/storage-claims";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import type { Database } from "../../shared/sqlite";
import { importedObjectId, listClaimLaneMemories } from "./claim-lane-import";
import { recordKernelMemoryRetrievals } from "./kernel-claim-usage";
import { promotedObjectId } from "./kernel-memory-promotion";

const PROJECT = "git:usage-project";
const ROOT = "/repo/usage";

function seedClaim(db: Database, key: string, content: string): string {
    const projectId = ensureProject(db, PROJECT);
    const result = createProjectMemoryClaim(
        db,
        { producer: "test", operationKey: `${PROJECT}:${key}` },
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

function retrievalCountOf(db: Database, publicClaimId: string): number {
    const claims = listClaimLaneMemories(db, PROJECT);
    const claim = claims?.find((item) => item.publicClaimId === publicClaimId);
    return claim?.telemetry.retrievalCount ?? -1;
}

describe("recordKernelMemoryRetrievals", () => {
    test("a hit under the imported or promoted derived id bumps the lane's retrieval count", () => {
        const db = createDirectTestDatabase({ path: ":memory:" }).db;
        const publicId = seedClaim(db, "a", "Own claim A.");
        expect(retrievalCountOf(db, publicId)).toBe(0);

        recordKernelMemoryRetrievals({
            db,
            projectPath: PROJECT,
            projectRoot: ROOT,
            objectIds: [importedObjectId(publicId, ROOT)],
        });
        expect(retrievalCountOf(db, publicId)).toBe(1);

        recordKernelMemoryRetrievals({
            db,
            projectPath: PROJECT,
            projectRoot: ROOT,
            objectIds: [promotedObjectId(publicId, ROOT)],
        });
        expect(retrievalCountOf(db, publicId)).toBe(2);
    });

    test("a kernel-only object id maps to no lane row and records nothing", () => {
        const db = createDirectTestDatabase({ path: ":memory:" }).db;
        const publicId = seedClaim(db, "a", "Own claim A.");
        recordKernelMemoryRetrievals({
            db,
            projectPath: PROJECT,
            projectRoot: ROOT,
            objectIds: [`mem_${"f".repeat(32)}`],
        });
        expect(retrievalCountOf(db, publicId)).toBe(0);
    });

    test("an empty hit list never reads the lane", () => {
        const db = createDirectTestDatabase({ path: ":memory:" }).db;
        recordKernelMemoryRetrievals({
            db,
            projectPath: PROJECT,
            projectRoot: ROOT,
            objectIds: [],
        });
    });
});
