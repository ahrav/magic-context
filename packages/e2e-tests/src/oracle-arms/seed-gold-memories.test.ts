/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeNormalizedHash } from "../../../plugin/src/features/magic-context/memory/normalize-hash";
import { resolveProjectIdentity } from "../../../plugin/src/features/magic-context/memory/project-identity";
import {
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
    type ProjectMemorySurface,
} from "../../../plugin/src/features/magic-context/memory/storage-claim-current-state";
import { initializeIsolatedContextDb } from "../initialize-context-db";
import { openTestDb } from "../test-db";
import { seedGoldMemories } from "./seed-gold-memories";

/** Returns the public claim IDs that the policy surface admits for `identity`. */
function surfaceClaimIds(
    dbPath: string,
    identity: string,
    surface: ProjectMemorySurface,
): string[] {
    const db = openTestDb(dbPath, { readonly: true });
    try {
        const state = readProjectMemoryCurrentState(db, {
            projectIds: resolveProjectIdsForIdentities(db, [identity]),
            surface,
        });
        if (state.status !== "ok") {
            throw new Error(`current-state read is stale: ${state.reasons.join(", ")}`);
        }
        return state.items.map((item) => item.publicClaimId);
    } finally {
        db.close();
    }
}

describe("seedGoldMemories", () => {
    it("seeds verified rows for the canonical workdir identity", () => {
        const root = mkdtempSync(join(tmpdir(), "oracle-gold-"));
        const dataDir = join(root, "data");
        const workdir = join(root, "work");
        const workdirAlias = join(root, "work-alias");
        const dbPath = join(dataDir, "cortexkit", "magic-context", "context.db");

        try {
            mkdirSync(workdir, { recursive: true });
            symlinkSync(workdir, workdirAlias);
            initializeIsolatedContextDb(dataDir);
            const rows = seedGoldMemories({
                workdir: workdirAlias,
                dbPath,
                verification: "verified",
                rows: [
                    { category: "PROJECT_RULES", content: "Use bun for package scripts." },
                    {
                        category: "CONFIG_VALUES",
                        content: "The retry limit is three.",
                        importance: 87,
                    },
                ],
            });

            const expectedIdentity = resolveProjectIdentity(realpathSync(workdirAlias));
            expect(rows).toHaveLength(2);
            expect(rows.every((row) => row.lifecycleState === "active")).toBe(true);
            expect(
                rows.every((row) => row.verification.latestOutcome === "verified"),
            ).toBe(true);
            expect(new Set(rows.map((row) => row.normalizedHash)).size).toBe(2);
            expect(rows[1]?.importance).toBe(87);

            const db = openTestDb(dbPath, { readonly: true });
            try {
                expect(
                    db.prepare(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claim_effective_policy'",
                    ).get(),
                ).toBeDefined();
                // The alias and its realpath resolve to the same canonical identity.
                const projectIds = resolveProjectIdsForIdentities(db, [expectedIdentity]);
                expect(projectIds).toHaveLength(1);
                expect(rows.map((row) => row.projectId)).toEqual([
                    projectIds[0],
                    projectIds[0],
                ]);
            } finally {
                db.close();
            }

            const seededIds = rows.map((row) => row.publicClaimId);
            expect(surfaceClaimIds(dbPath, expectedIdentity, "explicit_search")).toEqual(
                seededIds,
            );
            expect(surfaceClaimIds(dbPath, expectedIdentity, "auto_inject")).toEqual(
                seededIds,
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps candidate rows explicit-search eligible but out of auto injection", () => {
        const root = mkdtempSync(join(tmpdir(), "oracle-candidate-"));
        const dataDir = join(root, "data");
        const workdir = join(root, "work");
        const dbPath = join(dataDir, "cortexkit", "magic-context", "context.db");

        try {
            mkdirSync(workdir, { recursive: true });
            initializeIsolatedContextDb(dataDir);
            const [candidate] = seedGoldMemories({
                workdir,
                dbPath,
                verification: "candidate",
                rows: [{ category: "PROJECT_RULES", content: "Candidate-only search fact." }],
            });
            if (!candidate) throw new Error("candidate seed returned no row");
            expect(candidate.verification.latestOutcome).toBeNull();

            const identity = resolveProjectIdentity(realpathSync(workdir));
            const db = openTestDb(dbPath, { readonly: true });
            try {
                expect(
                    db.prepare(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claim_effective_policy'",
                    ).get(),
                ).toBeDefined();
            } finally {
                db.close();
            }
            expect(surfaceClaimIds(dbPath, identity, "explicit_search")).toEqual([
                candidate.publicClaimId,
            ]);
            expect(surfaceClaimIds(dbPath, identity, "auto_inject")).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects a missing context database without creating it", () => {
        const root = mkdtempSync(join(tmpdir(), "oracle-missing-db-"));
        const workdir = join(root, "work");
        const dbPath = join(root, "missing", "context.db");

        try {
            mkdirSync(workdir, { recursive: true });
            mkdirSync(dirname(dbPath), { recursive: true });
            expect(() =>
                seedGoldMemories({
                    workdir,
                    dbPath,
                    verification: "verified",
                    rows: [{ category: "PROJECT_RULES", content: "This must not be written." }],
                }),
            ).toThrow("seedGoldMemories: context.db does not exist");
            expect(existsSync(dbPath)).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("resolves duplicate content onto the live claim and leaves its revision intact", () => {
        const root = mkdtempSync(join(tmpdir(), "oracle-duplicate-"));
        const dataDir = join(root, "data");
        const workdir = join(root, "work");
        const dbPath = join(dataDir, "cortexkit", "magic-context", "context.db");

        try {
            mkdirSync(workdir, { recursive: true });
            initializeIsolatedContextDb(dataDir);
            // The second row normalizes to the first row's hash in the same (project, category) slot.
            // The claims kernel attaches the second row's provenance as independent evidence instead of opening a rival claim.
            // The claims kernel attaches the second row's provenance as independent evidence instead of opening a rival claim.
            const rows = seedGoldMemories({
                workdir,
                dbPath,
                verification: "candidate",
                rows: [
                    { category: "PROJECT_RULES", content: "Duplicate gold fact." },
                    { category: "PROJECT_RULES", content: "  duplicate   GOLD fact.  " },
                ],
            });

            expect(rows).toHaveLength(2);
            expect(new Set(rows.map((row) => row.publicClaimId)).size).toBe(1);
            // The second row's evidence attaches without superseding the first claim.
            // The surviving claim retains the first row's content at revision 1.
            expect(rows.map((row) => row.revision)).toEqual([1, 1]);
            expect(rows.map((row) => row.content)).toEqual([
                "Duplicate gold fact.",
                "Duplicate gold fact.",
            ]);
            const expectedHash = computeNormalizedHash("Duplicate gold fact.");
            expect(rows.map((row) => row.normalizedHash)).toEqual([
                expectedHash,
                expectedHash,
            ]);

            const identity = resolveProjectIdentity(realpathSync(workdir));
            expect(surfaceClaimIds(dbPath, identity, "explicit_search")).toEqual([
                rows[0]?.publicClaimId,
            ]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
