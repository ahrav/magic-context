import type { Database } from "../../../shared/sqlite";
import {
    countProjectMemoryClaims,
    hasClaimMemoryFragment,
    resolveProjectIdsForIdentities,
} from "../memory/storage-claim-current-state";
import { antiMemoryClaimSql, uniformlyAbsentClaimSql } from "../memory/storage-claim-visibility";
import { MURAL_CUE_RENDERER_EPOCH } from "../mural/storage-mural-cues";
import { getProjectEmbeddingSnapshot } from "../project-embedding-registry";
import {
    getSmartNotesNeedingCompilation,
    getStaleCompiledSmartNotes,
} from "../smart-notes/storage";
import { getPendingSmartNotes } from "../storage-notes";
import {
    countPrimerCandidatesForProject,
    getActivePrimers,
    hasPrimerRowsWithStaleEmbeddings,
} from "../storage-primers";
import { getUserMemoryCandidates } from "../user-memory/storage-user-memory";
import { countPendingCorrectionEvents } from "./anti-memory-from-corrections";
import { getTaskScheduleState } from "./storage-task-schedule";
import {
    CANONICAL_DREAM_TASKS,
    type DreamTaskBacklog,
    type DreamTaskBacklogMap,
    type DreamTaskName,
} from "./task-registry";

/**
 * `DreamTaskName` makes task renames fail to compile here.
 */
const CLASSIFY_MEMORIES_TASK: DreamTaskName = "classify-memories";

/**
 * A due task runs only when its gate passes.
 * Gates allow execution when counts are uncertain.
 *
 * `lastRunAt = null` makes changed-since gates test whether any work exists.
 */

export interface TaskGateContext {
    db: Database;
    projectIdentity: string;
    lastRunAt: number | null;
    /** `retrospectiveWatermarkMs` is the maximum scanned message timestamp.
     * A session updated mid-run can be newer than its scanned content but older than run completion.
     * Gating on `lastRunAt` would skip such a session. */
    retrospectiveWatermarkMs?: number | null;
    /* */
    promotionThreshold: number;
}

export function countActiveMemories(db: Database, projectPath: string): number {
    return countProjectMemoryClaims(db, {
        projectIds: resolveProjectIdsForIdentities(db, [projectPath]),
    });
}

const ACTIVE_CLAIM_BASE_SQL = `
    FROM claim_public_ids cpi
    JOIN claims ON claims.id = cpi.claim_id
    JOIN claim_memory_lifecycle_heads heads
      ON heads.claim_id = claims.id AND heads.state = 'active'
   WHERE claims.project_id = ?
     AND NOT ${antiMemoryClaimSql("claims.current_revision_id")}
     AND NOT ${uniformlyAbsentClaimSql("claims.current_revision_id", "unixepoch('subsec') * 1000")}`;

/**
 * path selector. */
const MAPPED_CLAIM_SQL = `
    EXISTS (
        SELECT 1
          FROM claim_revision_applicability_streams stream
          JOIN claim_revision_applicability_assertions assertion
            ON assertion.stream_id = stream.id
         WHERE stream.revision_id = claims.current_revision_id
           AND stream.stream_key = 'baseline:v1'
           AND assertion.seq = (
               SELECT MAX(history.seq) FROM claim_revision_applicability_assertions history
               WHERE history.stream_id = stream.id
           )
           AND assertion.paths_state = 'known'
           AND EXISTS (
               SELECT 1 FROM claim_revision_applicability_paths paths
               WHERE paths.assertion_id = assertion.id
           )
    )`;

function countActiveClaimsWhere(
    db: Database,
    projectPath: string,
    condition: string,
    conditionParams: readonly unknown[] = [],
): number {
    if (!hasClaimMemoryFragment(db)) return 0;
    const projectIds = resolveProjectIdsForIdentities(db, [projectPath]);
    if (projectIds.length === 0) return 0;
    const row = db
        .prepare(
            // pi-lens-ignore: sql-injection
            `SELECT COUNT(*) AS cnt ${ACTIVE_CLAIM_BASE_SQL} AND ${condition}`,
        )
        .get(...projectIds, ...conditionParams) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
}

/* */
export function countUnmappedActiveMemories(db: Database, projectPath: string): number {
    return countActiveClaimsWhere(
        db,
        projectPath,
        `NOT EXISTS (
            SELECT 1
              FROM claim_revision_applicability_streams stream
              JOIN claim_revision_applicability_assertions assertion
                ON assertion.stream_id = stream.id
             WHERE stream.revision_id = claims.current_revision_id
               AND stream.stream_key = 'baseline:v1'
               AND assertion.seq = (
                   SELECT MAX(history.seq) FROM claim_revision_applicability_assertions history
                   WHERE history.stream_id = stream.id
               )
               AND assertion.paths_state = 'known'
        )`,
    );
}

export function countCompartmentsSince(db: Database, projectPath: string, since: number): number {
    // Compartments are keyed by session_id; map to project via session_projects.
    const row = db
        .prepare<[string, number], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM compartments c
               JOIN session_projects sp ON sp.session_id = c.session_id
              WHERE sp.project_path = ? AND c.created_at > ?`,
        )
        .get(projectPath, since);
    return row?.cnt ?? 0;
}

/**
 * `retrospectiveWatermarkMs` defines the baseline for retrospective new-work checks.
 *
 * `countProjectSessionsSince` counts every project-lifetime session when given null.
 * An omitted watermark falls back to the persisted content watermark.
 * The persisted watermark prevents an omitted option from meaning no watermark.
 * The activity gate and backlog probe use the same resolved watermark.
 */
function resolveRetrospectiveWatermark(
    db: Database,
    projectPath: string,
    supplied: number | null | undefined,
): number | null {
    return (
        supplied ??
        getTaskScheduleState(db, projectPath, "retrospective")?.retrospectiveWatermarkMs ??
        null
    );
}

export function countProjectSessionsSince(
    db: Database,
    projectPath: string,
    since: number | null,
): number {
    const row =
        since === null
            ? db
                  .prepare<[string], { cnt: number }>(
                      "SELECT COUNT(*) AS cnt FROM session_projects WHERE project_path = ?",
                  )
                  .get(projectPath)
            : db
                  .prepare<[string, number], { cnt: number }>(
                      "SELECT COUNT(*) AS cnt FROM session_projects WHERE project_path = ? AND updated_at > ?",
                  )
                  .get(projectPath, since);
    return row?.cnt ?? 0;
}

function countMappedMemories(db: Database, projectPath: string): number {
    return countActiveClaimsWhere(db, projectPath, MAPPED_CLAIM_SQL);
}

function countUnverifiedMappedMemories(db: Database, projectPath: string): number {
    return countActiveClaimsWhere(
        db,
        projectPath,
        `${MAPPED_CLAIM_SQL} AND NOT EXISTS (
            SELECT 1 FROM verification_events
            WHERE verification_events.revision_id = claims.current_revision_id
        )`,
    );
}

function countBroadCycleCandidates(
    db: Database,
    projectPath: string,
    cycleStartAt: number,
): number {
    if (!hasClaimMemoryFragment(db)) return 0;
    const projectIds = resolveProjectIdsForIdentities(db, [projectPath]);
    if (projectIds.length === 0) return 0;
    const row = db
        .prepare(
            // pi-lens-ignore: sql-injection
            `SELECT COUNT(*) AS cnt ${ACTIVE_CLAIM_BASE_SQL} AND ${MAPPED_CLAIM_SQL}
                AND COALESCE((
                    SELECT MAX(created_at) FROM verification_events
                    WHERE verification_events.revision_id = claims.current_revision_id
                ), 0) < ?`,
        )
        .get(...projectIds, cycleStartAt) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
}

function countCueCandidates(db: Database, projectPath: string): number {
    if (!hasClaimMemoryFragment(db)) return 0;
    const projectIds = resolveProjectIdsForIdentities(db, [projectPath]);
    if (projectIds.length === 0) return 0;
    const row = db
        .prepare(
            // pi-lens-ignore: sql-injection
            `SELECT COUNT(*) AS cnt ${ACTIVE_CLAIM_BASE_SQL}
                AND NOT EXISTS (
                    SELECT 1
                      FROM claim_mural_cues cues
                      JOIN claim_revisions revision ON revision.id = claims.current_revision_id
                     WHERE cues.claim_id = claims.id
                       AND cues.cue IS NOT NULL
                       AND cues.renderer_epoch = ?
                       AND cues.revision_locator =
                           cpi.public_id || '/r' || revision.revision || '/' || revision.content_sha256
                )`,
        )
        .get(...projectIds, MURAL_CUE_RENDERER_EPOCH) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
}

function countStalePrimers(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            `SELECT COUNT(*) AS cnt
               FROM primers
              WHERE project_path = ?
                AND status = 'active'
                AND (answer IS NULL OR TRIM(answer) = '' OR answer_refreshed_at IS NULL
                     OR last_observed_at > answer_refreshed_at)`,
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

/**
 *
 */
function countUnclassifiedActiveMemories(db: Database, projectPath: string): number {
    return countActiveClaimsWhere(
        db,
        projectPath,
        `NOT EXISTS (
            SELECT 1
              FROM claim_evidence evidence
              JOIN observations observation ON observation.id = evidence.observation_id
             WHERE evidence.revision_id = claims.current_revision_id
               AND observation.independence_key LIKE ?
        )`,
        [`${CLASSIFY_MEMORIES_TASK}:%`],
    );
}

function countPendingSmartNotes(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            "SELECT COUNT(*) AS cnt FROM notes WHERE project_path = ? AND type = 'smart' AND status = 'pending'",
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

function countUserMemoryCandidates(db: Database): number {
    const row = db
        .prepare<[], { cnt: number }>("SELECT COUNT(*) AS cnt FROM user_memory_candidates")
        .get();
    return row?.cnt ?? 0;
}

function countActivePrimers(db: Database, projectPath: string): number {
    const row = db
        .prepare<[string], { cnt: number }>(
            "SELECT COUNT(*) AS cnt FROM primers WHERE project_path = ? AND status = 'active'",
        )
        .get(projectPath);
    return row?.cnt ?? 0;
}

/**
 * The backlog probe is read-only and does not acquire a lease, materialize a prompt cache, or invoke a model.
 */
export function getDreamTaskBacklog(
    db: Database,
    projectPath: string,
    task: DreamTaskName,
    options: { lastRunAt?: number | null; retrospectiveWatermarkMs?: number | null } = {},
): DreamTaskBacklog {
    switch (task) {
        case "map-memories": {
            const total = countActiveMemories(db, projectPath);
            return { pending: countUnmappedActiveMemories(db, projectPath), total };
        }
        case "verify": {
            return {
                pending: countUnverifiedMappedMemories(db, projectPath),
                total: countMappedMemories(db, projectPath),
            };
        }
        case "verify-broad": {
            const total = countMappedMemories(db, projectPath);
            const cycleStartAt = getTaskScheduleState(
                db,
                projectPath,
                "verify-broad",
            )?.lastBroadRunAt;
            // The next broad run opens a cycle over the mapped pool when no cycle is open.
            // An open cycle reports only memories not yet verified for that cycle.
            // Reporting only unverified memories keeps run telemetry aligned with the resumable backlog.
            const pending =
                cycleStartAt == null
                    ? total
                    : countBroadCycleCandidates(db, projectPath, cycleStartAt);
            return { pending, total };
        }
        case "curate": {
            const total = countActiveMemories(db, projectPath);
            return { pending: total, total };
        }
        case "compress-cues": {
            const total = countActiveMemories(db, projectPath);
            return { pending: countCueCandidates(db, projectPath), total };
        }
        case "classify-memories": {
            const total = countActiveMemories(db, projectPath);
            return { pending: countUnclassifiedActiveMemories(db, projectPath), total };
        }
        case "retrospective": {
            const watermarkMs = resolveRetrospectiveWatermark(
                db,
                projectPath,
                options.retrospectiveWatermarkMs,
            );
            const pendingSessions = countProjectSessionsSince(db, projectPath, watermarkMs);
            const pending = pendingSessions + countPendingCorrectionEvents(db, projectPath);
            return { pending, total: pending };
        }
        case "maintain-docs": {
            const total = countCompartmentsSince(db, projectPath, 0);
            const pending = countCompartmentsSince(db, projectPath, options.lastRunAt ?? 0);
            return { pending, total };
        }
        case "evaluate-smart-notes": {
            const pending = countPendingSmartNotes(db, projectPath);
            return { pending, total: pending };
        }
        case "review-user-memories": {
            const pending = countUserMemoryCandidates(db);
            return { pending, total: pending };
        }
        case "promote-primers": {
            const pending = countPrimerCandidatesForProject(db, projectPath);
            return { pending, total: pending };
        }
        case "refresh-primers": {
            const total = countActivePrimers(db, projectPath);
            return { pending: countStalePrimers(db, projectPath), total };
        }
        default: {
            const _exhaustive: never = task;
            return _exhaustive;
        }
    }
}

/** The function returns backlog entries in registry order. */
export function getDreamTaskBacklogs(
    db: Database,
    projectPath: string,
    tasks: readonly DreamTaskName[] = CANONICAL_DREAM_TASKS,
    options: { lastRunAt?: number | null; retrospectiveWatermarkMs?: number | null } = {},
): DreamTaskBacklogMap {
    const result: DreamTaskBacklogMap = {};
    for (const task of tasks) result[task] = getDreamTaskBacklog(db, projectPath, task, options);
    return result;
}

/**
 * Database read errors propagate instead of being treated as no work.
 */
export function evaluateTaskGate(task: DreamTaskName, ctx: TaskGateContext): boolean {
    const { db, projectIdentity: project, lastRunAt } = ctx;
    switch (task) {
        case "map-memories":
            // The task runs while active unmapped memories remain and no-ops after the backfill drains the pool.
            return countUnmappedActiveMemories(db, project) > 0;

        case "verify":
            // scheduler only avoids taking the memory lease when there is no pool.
            return countActiveMemories(db, project) > 0;

        case "verify-broad":
            // An open cycle remains runnable after another task removes the last active memory.
            return (
                getTaskScheduleState(db, project, "verify-broad")?.lastBroadRunAt != null ||
                countActiveMemories(db, project) > 0
            );

        case "curate":
            return countActiveMemories(db, project) > 0;

        case "compress-cues":
            return countActiveMemories(db, project) > 0;

        case "classify-memories":
            return countActiveMemories(db, project) > 0;

        case "retrospective":
            // The task runs when pending correction events exist or project sessions changed since the retrospective watermark.
            //
            return (
                countPendingCorrectionEvents(db, project) > 0 ||
                countProjectSessionsSince(
                    db,
                    project,
                    resolveRetrospectiveWatermark(db, project, ctx.retrospectiveWatermarkMs),
                ) > 0
            );

        case "maintain-docs":
            // When lastRunAt is null, zero admits any existing compartment.
            return countCompartmentsSince(db, project, lastRunAt ?? 0) > 0;

        case "evaluate-smart-notes":
            return (
                getSmartNotesNeedingCompilation(db, project, Date.now(), 1).length > 0 ||
                getStaleCompiledSmartNotes(db, project, Date.now(), 1).length > 0 ||
                getPendingSmartNotes(db, project).some((note) => note.checkStatus === "fallback")
            );

        case "review-user-memories":
            return getUserMemoryCandidates(db).length >= ctx.promotionThreshold;

        case "promote-primers": {
            if (countPrimerCandidatesForProject(db, project) >= (ctx.promotionThreshold ?? 2)) {
                return true;
            }
            const snapshot = getProjectEmbeddingSnapshot(project);
            if (!snapshot?.enabled) return false;
            return hasPrimerRowsWithStaleEmbeddings(db, project, snapshot.modelId);
        }

        case "refresh-primers":
            return getActivePrimers(db, project).some(
                (primer) =>
                    !primer.answer.trim() ||
                    primer.answerRefreshedAt == null ||
                    (primer.lastObservedAt ?? 0) > primer.answerRefreshedAt,
            );

        default: {
            const _exhaustive: never = task;
            return Boolean(_exhaustive);
        }
    }
}
