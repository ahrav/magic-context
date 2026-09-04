/**
 * The claim lane records explicit-search retrieval telemetry for matching kernel hits: a hit resolves to a lane row through the derived object ids the claim-lane importer and the historian promotion write under, and the Dreamer's curate pass reads the lane's `retrieval_count` as its keep signal. A kernel-only row (one `ctx_memory` created directly) has no lane row and records nothing. commentlint: allow(JUDGE)
 */

// biome-ignore lint/style/noRestrictedImports: `recordClaimUsage` only writes usage counters — it bumps lane `retrieval_count` for delivered kernel hits and serves no lane content onto the memory path, which is the read the ban exists to prevent. commentlint: allow(JUDGE)
import { recordClaimUsage } from "../../features/magic-context/memory/storage-claim-operations";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    importedObjectId,
    listClaimLaneMemories,
    readImportRegenerations,
} from "./claim-lane-import";
import { promotedObjectId } from "./kernel-memory-promotion";

export function recordKernelMemoryRetrievals(args: {
    db: Database;
    projectPath: string;
    /** The checkout root the kernel scope is bound to; the derived ids are keyed by it. */
    projectRoot: string;
    /** Kernel object ids of the memory hits a search delivered. */
    objectIds: readonly string[];
}): void {
    if (args.objectIds.length === 0) return;
    const hits = new Set(args.objectIds);
    // Telemetry, not correctness: a stale lane snapshot or a fenced lane
    // write skips the bump instead of failing the search.
    try {
        const claims = listClaimLaneMemories(args.db, args.projectPath);
        if (claims === null) return;
        // A claim revoked and reauthorized lives under a regenerated import id; matching only generation zero would leave its retrieval count frozen and let the curate policy archive an actively retrieved memory. commentlint: allow(JUDGE)
        const regenerations = readImportRegenerations(args.db, args.projectPath, args.projectRoot);
        const publicClaimIds = claims
            .filter(
                (claim) =>
                    hits.has(importedObjectId(claim.publicClaimId, args.projectRoot)) ||
                    hits.has(
                        importedObjectId(
                            claim.publicClaimId,
                            args.projectRoot,
                            regenerations[claim.publicClaimId] ?? 0,
                        ),
                    ) ||
                    hits.has(promotedObjectId(claim.publicClaimId, args.projectRoot)),
            )
            .map((claim) => claim.publicClaimId);
        if (publicClaimIds.length === 0) return;
        recordClaimUsage(args.db, { publicClaimIds, kind: "retrieved" });
    } catch (error) {
        log("[magic-context] kernel retrieval telemetry skipped", error);
    }
}
