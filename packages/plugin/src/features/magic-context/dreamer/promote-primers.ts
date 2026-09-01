import type { PluginContext } from "../../../plugin/types";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import {
    buildPrimerClusters,
    clusterEligibleForPromotion,
    PRIMER_CLUSTER_THRESHOLD,
    PRIMER_MIN_SPAN_DAYS,
    PRIMER_PROMOTION_THRESHOLD,
    summarizePrimerCluster,
} from "../primer-clustering";
import { embedBatchForProject, getProjectEmbeddingSnapshot } from "../project-embedding-registry";
import {
    createPrimer,
    getActivePrimers,
    getPrimerCandidatesForPromotion,
    PRIMER_CANDIDATE_MAX_AGE_MS,
    PRIMER_CANDIDATE_TTL_MS,
    updatePrimerCandidateEmbedding,
    updatePrimerQuestionEmbedding,
    updatePrimerSupport,
} from "../storage-primers";
import {
    type LeaseAcquisition,
    peekLeaseHolderAndExpiry,
    runLeaseGuardedWrite,
    startLeaseHeartbeat,
} from "./lease";

export interface PromotePrimersArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    promotionThreshold?: number;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void> | void;
}

export interface PromotePrimersResult {
    promoted: number;
    updated: number;
    candidates: number;
    pruned: number;
}

function canonicalQuestionFromCluster(
    candidates: { question: string; sourceMessageTime: number; id: number }[],
): string {
    const sorted = candidates
        .slice()
        .sort((a, b) => a.sourceMessageTime - b.sourceMessageTime || a.id - b.id);
    const first = sorted[0]?.question.trim() ?? "";
    if (!first) return "How does this project subsystem work?";
    return first.endsWith("?") ? first : `${first}?`;
}

/** REEMBED_CHUNK_SIZE bounds local inference memory.
 * A failed chunk leaves writes from earlier chunks intact.
 * A later call selects rows whose embeddings remain stale. */
const REEMBED_CHUNK_SIZE = 32;

/** Re-embeds primer candidates and active primers with missing vectors or model IDs that differ from the current provider identity.
 * When supplied, `checkpoint` runs before each database write.
 * */
export async function reembedStalePrimerEmbeddings(
    db: Database,
    projectIdentity: string,
    checkpoint?: () => void,
): Promise<number> {
    if (!getProjectEmbeddingSnapshot(projectIdentity)?.enabled) return 0;
    // The empty batch obtains the provider identity used by `isStale`.
    // running inference.
    const current = await embedBatchForProject(projectIdentity, [], undefined, "passage");
    if (!current) return 0;
    const isStale = (embedding: Float32Array | null, modelId: string | null): boolean =>
        !embedding || !modelId || modelId !== current.modelId;

    type StaleRow = { kind: "candidate" | "primer"; id: number; question: string };
    const rows: StaleRow[] = [
        ...getPrimerCandidatesForPromotion(db, projectIdentity)
            .filter((c) => isStale(c.questionEmbedding, c.questionEmbeddingModelId))
            .map((c): StaleRow => ({ kind: "candidate", id: c.id, question: c.question })),
        ...getActivePrimers(db, projectIdentity)
            .filter((p) => isStale(p.questionEmbedding, p.questionEmbeddingModelId))
            .map((p): StaleRow => ({ kind: "primer", id: p.id, question: p.question })),
    ];
    if (rows.length === 0) return 0;

    let written = 0;
    for (let offset = 0; offset < rows.length; offset += REEMBED_CHUNK_SIZE) {
        const chunk = rows.slice(offset, offset + REEMBED_CHUNK_SIZE);
        const batch = await embedBatchForProject(
            projectIdentity,
            chunk.map((row) => row.question),
            undefined,
            "passage",
        );
        checkpoint?.();
        // Stop after a failed chunk; prior chunk writes remain.
        // Rows written by earlier chunks no longer satisfy `isStale`.
        if (!batch) return written;
        for (let i = 0; i < chunk.length; i += 1) {
            checkpoint?.();
            const vector = batch.vectors[i];
            if (!vector) continue;
            const row = chunk[i];
            if (row.kind === "candidate") {
                updatePrimerCandidateEmbedding(db, row.id, vector, batch.modelId);
            } else {
                updatePrimerQuestionEmbedding(db, row.id, vector, batch.modelId);
            }
            written += 1;
        }
    }
    return written;
}

async function embedMissingCandidates(
    args: PromotePrimersArgs,
    assertLeaseHeld: (phase: string) => void,
): Promise<void> {
    await args.ensureProjectRegistered?.(args.sessionDirectory, args.db);
    assertLeaseHeld("embedding registration");
    await reembedStalePrimerEmbeddings(args.db, args.projectIdentity, () =>
        assertLeaseHeld("embedding commit"),
    );
}

function pruneExpiredPrimerCandidatesForProject(
    db: Database,
    projectIdentity: string,
    now = Date.now(),
    ttlMs = PRIMER_CANDIDATE_TTL_MS,
    maxAgeMs = PRIMER_CANDIDATE_MAX_AGE_MS,
): number {
    const protectedIds = new Set<number>();
    for (const primer of getActivePrimers(db, projectIdentity)) {
        for (const id of primer.sourceCandidateIds) protectedIds.add(id);
    }
    const oldRows = db
        .prepare(
            `SELECT id, source_message_time
               FROM primer_candidates
              WHERE project_path = ? AND source_message_time < ?`,
        )
        .all(projectIdentity, now - ttlMs) as Array<{ id: number; source_message_time: number }>;
    const toDelete = oldRows
        .filter((row) => !protectedIds.has(row.id) || row.source_message_time < now - maxAgeMs)
        .map((row) => row.id);
    if (toDelete.length === 0) return 0;
    const stmt = db.prepare("DELETE FROM primer_candidates WHERE id = ? AND project_path = ?");
    db.transaction(() => {
        for (const id of toDelete) stmt.run(id, projectIdentity);
    })();
    return toDelete.length;
}

export async function promotePrimers(args: PromotePrimersArgs): Promise<PromotePrimersResult> {
    const result: PromotePrimersResult = { promoted: 0, updated: 0, candidates: 0, pruned: 0 };
    let leaseLost = false;
    const assertLeaseHeld = (phase: string): void => {
        if (leaseLost || !peekLeaseHolderAndExpiry(args.db, args.holderId, args.leaseKey)) {
            leaseLost = true;
            throw new Error(`Dream lease lost during promote-primers ${phase}`);
        }
    };
    const heartbeat = startLeaseHeartbeat(
        args.db,
        args.holderId,
        args.leaseKey,
        () => {
            leaseLost = true;
            log("[dreamer] primers: lease lost during promote-primers — aborting");
        },
        args.leaseAcquisition,
    );

    try {
        assertLeaseHeld("prune start");
        result.pruned = pruneExpiredPrimerCandidatesForProject(
            args.db,
            args.projectIdentity,
            Date.now(),
            PRIMER_CANDIDATE_TTL_MS,
        );
        if (result.pruned > 0) {
            log(`[dreamer] primers: decayed ${result.pruned} expired candidate(s)`);
        }

        try {
            await embedMissingCandidates(args, assertLeaseHeld);
        } catch (error) {
            if (leaseLost) throw error;
            log(
                `[dreamer] primers: embedding unavailable; falling back to normalized-text clusters: ${error}`,
            );
        }
        assertLeaseHeld("cluster start");

        const candidates = getPrimerCandidatesForPromotion(args.db, args.projectIdentity);
        result.candidates = candidates.length;
        if (candidates.length === 0) return result;

        const primers = getActivePrimers(args.db, args.projectIdentity);
        const clusters = buildPrimerClusters({
            candidates,
            activePrimers: primers,
            threshold: PRIMER_CLUSTER_THRESHOLD,
        });

        runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
            for (const cluster of clusters) {
                if (cluster.candidates.length === 0) continue;
                const summary = summarizePrimerCluster(cluster);
                if (cluster.primer) {
                    updatePrimerSupport(args.db, {
                        primerId: cluster.primer.id,
                        questionEmbedding: summary.centroid,
                        questionEmbeddingModelId: summary.modelId,
                        totalSupport: summary.support,
                        lastObservedAt: summary.lastObservedAt,
                        sourceCandidateIds: summary.sourceCandidateIds,
                    });
                    result.updated += 1;
                    continue;
                }
                if (
                    !clusterEligibleForPromotion(
                        summary,
                        args.promotionThreshold ?? PRIMER_PROMOTION_THRESHOLD,
                        PRIMER_MIN_SPAN_DAYS,
                    )
                ) {
                    continue;
                }
                createPrimer(args.db, {
                    projectPath: args.projectIdentity,
                    question: canonicalQuestionFromCluster(summary.candidates),
                    questionEmbedding: summary.centroid,
                    questionEmbeddingModelId: summary.modelId,
                    totalSupport: summary.support,
                    lastObservedAt: summary.lastObservedAt,
                    sourceCandidateIds: summary.sourceCandidateIds,
                });
                result.promoted += 1;
            }
        });
        if (leaseLost) throw new Error("Dream lease lost during promote-primers commit");
        log(
            `[dreamer] primers: candidates=${result.candidates} promoted=${result.promoted} updated=${result.updated}`,
        );
        return result;
    } finally {
        heartbeat.stop();
    }
}
