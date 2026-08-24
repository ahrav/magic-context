import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import {
    embedBatchForProject,
    embedMemoriesDetailedForProject,
    getProjectEmbeddingSnapshot,
} from "./embedding";
import {
    exactMemoryContentDigests,
    memoriesEligibleForEmbedding,
} from "./storage-claim-visibility";
import { sha256Utf8Hex } from "./storage-claims";
import {
    type StoredMemoryEmbedding,
    saveEmbeddingIfHashMatches,
} from "./storage-memory-embeddings";
import type { Memory } from "./types";

export async function ensureMemoryEmbeddings(args: {
    db: Database;
    projectIdentity: string;
    memories: Memory[];
    existingEmbeddings: Map<number, StoredMemoryEmbedding>;
}): Promise<Map<number, StoredMemoryEmbedding>> {
    const snapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
    if (!snapshot?.enabled) {
        return args.existingEmbeddings;
    }

    const missingMemories = args.memories.filter(
        (memory) => !args.existingEmbeddings.has(memory.id),
    );
    if (missingMemories.length === 0) {
        return args.existingEmbeddings;
    }

    try {
        const detailed = await embedMemoriesDetailedForProject(
            args.db,
            args.projectIdentity,
            missingMemories.map((memory) => ({ id: memory.id, content: memory.content })),
        );
        if (detailed) {
            for (const [id, stored] of detailed) {
                args.existingEmbeddings.set(id, stored);
            }
            return args.existingEmbeddings;
        }

        // The detailed lane above rechecks at its own drain; this legacy
        // fallback would otherwise ship the frozen contents straight to the
        // provider. Revalidate policy eligibility and exact-bind every row
        // to its current claim revision immediately before the call — a row
        // hidden or rewritten since the search filter must not be disclosed,
        // and the post-call save guard cannot undo that disclosure.
        const eligibleAtCall = memoriesEligibleForEmbedding(
            args.db,
            missingMemories.map((memory) => memory.id),
        );
        const digestsAtCall = exactMemoryContentDigests(
            args.db,
            missingMemories.map((memory) => memory.id),
        );
        // Policy again AFTER the digest read (two autocommit snapshots): a
        // hide committed between them leaves the digest unchanged.
        const eligibleAfterCall = memoriesEligibleForEmbedding(
            args.db,
            missingMemories.map((memory) => memory.id),
        );
        const boundMissing = missingMemories.filter(
            (memory) =>
                eligibleAtCall.has(memory.id) &&
                digestsAtCall.get(memory.id) === sha256Utf8Hex(memory.content) &&
                eligibleAfterCall.has(memory.id),
        );
        if (boundMissing.length === 0) {
            return args.existingEmbeddings;
        }
        const result = await embedBatchForProject(
            args.projectIdentity,
            boundMissing.map((memory) => memory.content),
        );
        if (!result) {
            return args.existingEmbeddings;
        }

        // Stage results before committing — only merge into the in-memory cache after
        // the transaction succeeds, so a rollback doesn't leave stale Map entries.
        const staged = new Map<number, StoredMemoryEmbedding>();
        args.db.transaction(() => {
            // Re-bind inside the write transaction: the provider call above
            // yielded, and the normalized-hash save guard alone cannot
            // reject a case/whitespace-only rewrite that landed meanwhile —
            // the save would reinstate the predecessor's vector (and cache
            // it) under the successor bytes.
            const digestsInTx = exactMemoryContentDigests(
                args.db,
                boundMissing.map((memory) => memory.id),
            );
            for (const [index, memory] of boundMissing.entries()) {
                if (digestsInTx.get(memory.id) !== sha256Utf8Hex(memory.content)) {
                    continue;
                }
                const embedding = result.vectors[index];
                if (!embedding) {
                    continue;
                }

                // The vector was computed from the content this memory had when the
                // batch was assembled. If the memory was edited while the provider
                // call was in flight, its normalized_hash no longer matches and the
                // guarded save discards the stale vector — leaving the row unembedded
                // so the proactive drain re-embeds the current content next round.
                // A skipped memory must not enter the cache either: a stale cached
                // vector would score searches until the cache is rebuilt.
                const saved = saveEmbeddingIfHashMatches(
                    args.db,
                    memory.id,
                    embedding,
                    result.modelId,
                    memory.normalizedHash,
                );
                if (saved) {
                    staged.set(memory.id, { embedding, modelId: result.modelId });
                }
            }
        })();

        const currentSnapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
        if (!currentSnapshot || currentSnapshot.generation !== result.generation) {
            return args.existingEmbeddings;
        }

        // Transaction committed — safe to merge into caller's cache
        for (const [id, embedding] of staged) {
            args.existingEmbeddings.set(id, embedding);
        }
    } catch (error) {
        log("[magic-context] failed to backfill memory embeddings:", error);
    }

    return args.existingEmbeddings;
}
