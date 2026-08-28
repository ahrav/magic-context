/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createClaimReaderTestDatabase, seedProjectMemoryClaim } from "../test-claim-database";
import { readAuthorizedClaimMemorySnapshot, renderClaimMemoryBlock } from "./claim-memory-render";
import { createAntiMemory } from "./storage-anti-memory";
import { ensureProject } from "./storage-claims";

describe("claim memory render anti-memory canary", () => {
    test("never renders a verified rejected approach as positive project memory", () => {
        const db = createClaimReaderTestDatabase();
        try {
            const projectIdentity = "git:anti-render";
            const positive = seedProjectMemoryClaim(db, {
                projectIdentity,
                content: "Positive architecture fact.",
            });
            createAntiMemory(
                db,
                { producer: "test", operationKey: "anti-render" },
                {
                    projectId: ensureProject(db, projectIdentity),
                    payload: {
                        trigger: "cache work",
                        rejectedStrategy: "use Redis",
                        rejectionReason: "operational burden",
                    },
                    provenance: {
                        sourceLocator: "transcript://anti-render",
                        sourceContent: "user rejected Redis",
                        extractor: "test",
                        extractorVersion: "1",
                        extractorRunId: "anti-render",
                        independenceKey: "anti-render",
                        sourceTrustClass: "explicit_user",
                    },
                    actor: "host:user-corroborated",
                    nowMs: 1,
                },
            );

            const snapshot = readAuthorizedClaimMemorySnapshot(db, {
                authorizedIdentities: [projectIdentity],
                ownIdentities: [projectIdentity],
                sharedCategories: [],
                workspaceEpoch: "",
                nowMs: 2,
            });
            const block = renderClaimMemoryBlock(snapshot?.items ?? []);
            expect(block).toContain(positive.publicClaimId);
            expect(block).not.toContain("Rejected strategy");
            expect(block).not.toContain("REJECTED_APPROACH");
        } finally {
            closeQuietly(db);
        }
    });
});
