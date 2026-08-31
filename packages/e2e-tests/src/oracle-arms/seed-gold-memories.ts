import { realpathSync, statSync } from "node:fs";
import {
    readProjectMemoryCurrentState,
    recordProjectMemoryVerification,
    resolveProjectIdentity,
    type MemoryCategory,
    type ProjectMemoryClaimSnapshot,
} from "../../../plugin/src/features/magic-context/memory";
import { seedProjectMemoryClaim } from "../../../plugin/src/features/magic-context/test-claim-database";
import { openTestDb } from "../test-db";

export interface GoldMemoryRow {
    category: MemoryCategory;
    content: string;
    importance?: number;
}

export interface SeedGoldMemoriesOptions {
    workdir: string;
    dbPath: string;
    rows: readonly GoldMemoryRow[];
    verification: "candidate" | "verified";
}

/**
 *
 *
 *
 */
export function seedGoldMemories(
    options: SeedGoldMemoriesOptions,
): ProjectMemoryClaimSnapshot[] {
    let db: ReturnType<typeof openTestDb>;
    try {
        db = openTestDb(options.dbPath, { readwrite: true, create: false });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "SQLITE_CANTOPEN") {
            try {
                statSync(options.dbPath);
            } catch (pathError) {
                if ((pathError as NodeJS.ErrnoException).code === "ENOENT") {
                    throw new Error(
                        `seedGoldMemories: context.db does not exist: ${options.dbPath}`,
                        { cause: error },
                    );
                }
            }
        }
        throw error;
    }
    try {
        const projectPath = resolveProjectIdentity(realpathSync(options.workdir));
        const seeded = options.rows.map((row) => {
            const claim = seedProjectMemoryClaim(db, {
                projectIdentity: projectPath,
                category: row.category,
                content: row.content,
                ...(row.importance === undefined
                    ? {}
                    : { importance: row.importance }),
                provenance: { sourceTrustClass: "model_inference" },
            });
            if (options.verification === "verified") {
                const result = recordProjectMemoryVerification(
                    db,
                    {
                        producer: "oracle-gold",
                        operationKey: `verify:${claim.publicClaimId}:${crypto.randomUUID()}`,
                    },
                    {
                        token: claim.token,
                        revisionLocator: claim.revisionLocator,
                        outcome: "verified",
                        verifier: "oracle-arm",
                    },
                );
                if (result.outcome !== "applied") {
                    throw new Error(
                        `seedGoldMemories: verification of ${claim.publicClaimId} returned ${result.outcome}`,
                    );
                }
            }
            return claim;
        });

        const state = readProjectMemoryCurrentState(db, {
            publicClaimIds: [...new Set(seeded.map((claim) => claim.publicClaimId))],
            surface: "explicit_search",
        });
        if (state.status !== "ok") {
            throw new Error(
                `seedGoldMemories: current-state read is stale: ${state.reasons.join(", ")}`,
            );
        }
        const byPublicClaimId = new Map(
            state.items.map((item) => [item.publicClaimId, item]),
        );
        return seeded.map((claim) => {
            const snapshot = byPublicClaimId.get(claim.publicClaimId);
            if (!snapshot) {
                throw new Error(
                    `seedGoldMemories: seeded claim ${claim.publicClaimId} is not visible to explicit search`,
                );
            }
            return snapshot;
        });
    } finally {
        db.close();
    }
}
