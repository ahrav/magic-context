import { sessionLog } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { CATEGORY_DEFAULT_TTL, PROMOTABLE_CATEGORIES } from "./constants";
import { embedTextForProject } from "./embedding";
import { computeNormalizedHash } from "./normalize-hash";
import {
    exactMemoryContentDigests,
    memoriesEligibleForEmbedding,
} from "./storage-claim-visibility";
import { sha256Utf8Hex } from "./storage-claims";
import {
    getMemoryByHash,
    getMemoryById,
    insertMemory,
    updateMemorySeenCount,
} from "./storage-memory";
import { saveEmbeddingIfHashMatches } from "./storage-memory-embeddings";
import type { MemoryCategory, MemoryInput } from "./types";

interface SessionFact {
    category: string;
    content: string;
}

export interface PromotedMemoryRef {
    memoryId: number;
    content: string;
}

function isPromotableCategory(category: string): category is MemoryCategory {
    return PROMOTABLE_CATEGORIES.some((promotableCategory) => promotableCategory === category);
}

function resolveExpiresAt(category: MemoryCategory): number | null {
    const ttl = CATEGORY_DEFAULT_TTL[category];
    return ttl === undefined ? null : Date.now() + ttl;
}

/**
 * Synchronously promote eligible session facts to cross-session memories.
 *
 * Transaction contract: callers may run this inside their publish transaction.
 * Storage failures deliberately propagate so the enclosing publication rolls
 * back atomically with the boundary; malformed/unpromotable facts are validation
 * skips and do not abort the publish.
 */
export function promoteSessionFactsDurable(
    db: Database,
    sessionId: string,
    projectPath: string,
    facts: SessionFact[],
): PromotedMemoryRef[] {
    const refs: PromotedMemoryRef[] = [];
    for (const fact of facts) {
        if (
            !fact ||
            typeof fact.category !== "string" ||
            typeof fact.content !== "string" ||
            fact.content.trim().length === 0
        ) {
            continue;
        }
        if (!isPromotableCategory(fact.category)) {
            continue;
        }

        const normalizedHash = computeNormalizedHash(fact.content);
        const existingMemory = getMemoryByHash(db, projectPath, fact.category, normalizedHash);

        if (existingMemory) {
            updateMemorySeenCount(db, existingMemory.id);
            continue;
        }

        const memoryInput: MemoryInput = {
            projectPath,
            category: fact.category,
            content: fact.content,
            sourceSessionId: sessionId,
            sourceType: "historian",
            expiresAt: resolveExpiresAt(fact.category),
        };

        const memory = insertMemory(db, memoryInput);
        refs.push({ memoryId: memory.id, content: memory.content });
    }

    return refs;
}

/**
 * Best-effort asynchronous embedding for newly promoted facts. Must run after
 * the durable publish transaction commits.
 */
export async function embedPromotedFacts(
    db: Database,
    sessionId: string,
    projectPath: string,
    refs: PromotedMemoryRef[],
): Promise<void> {
    // One batched eligibility read for the whole promotion batch: the
    // underlying policy-row query already chunks an IN list, and the surface
    // is identical for every ref. Each ref still re-checks membership at its
    // own turn below (the loop awaits provider calls, so eligibility is
    // re-read per ref against this stale-but-conservative snapshot only for
    // the initial skip; the hash-guarded save rejects mid-flight edits).
    const eligible = memoriesEligibleForEmbedding(
        db,
        refs.map((ref) => ref.memoryId),
    );
    for (const ref of refs) {
        if (!eligible.has(ref.memoryId)) continue;
        await embedAndStoreMemory(db, sessionId, projectPath, ref.memoryId, ref.content);
    }
}

async function embedAndStoreMemory(
    db: Database,
    sessionId: string,
    projectPath: string,
    memoryId: number,
    content: string,
): Promise<void> {
    try {
        // Hard-hidden / rejected content never leaves the process, remote
        // embedding providers included. Re-checked here (cheap single-id
        // read) because earlier refs' provider calls yield arbitrarily long.
        if (!memoriesEligibleForEmbedding(db, [memoryId]).has(memoryId)) {
            return;
        }
        // Bind the captured bytes to the current revision: a rewrite after
        // publication makes eligibility (and the hash captured below)
        // describe the NEW revision while `content` still holds the old
        // promoted bytes — embedding them would disclose a superseded
        // revision to the provider and store its vector as if it described
        // the replacement.
        if (exactMemoryContentDigests(db, [memoryId]).get(memoryId) !== sha256Utf8Hex(content)) {
            return;
        }
        // Capture the row's content hash BEFORE the async provider call: the
        // vector it returns is only valid for the content stored right now. If
        // the memory is edited while the call is in flight, the row's
        // normalized_hash changes and the guarded save below discards the stale
        // vector instead of resurrecting an out-of-date row — the memory then
        // stays unembedded until the proactive drain re-embeds current content.
        const hashBeforeEmbed = getMemoryById(db, memoryId)?.normalizedHash;
        if (!hashBeforeEmbed) {
            return;
        }
        const result = await embedTextForProject(projectPath, content);
        if (result) {
            db.transaction(() => {
                saveEmbeddingIfHashMatches(
                    db,
                    memoryId,
                    result.vector,
                    result.modelId,
                    hashBeforeEmbed,
                );
            })();
        }
    } catch (error) {
        sessionLog(sessionId, `memory embedding failed for memory ${memoryId}:`, error);
    }
}
