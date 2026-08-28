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
 * Prefix of the independence key a classify-memories pass stamps on the
 * evidence it writes. `claim-manifest.ts` builds those keys as
 * `<task>:<leaseGeneration>:<publicClaimId>`, so the task name typed against
 * `DreamTaskName` is the whole coupling — a task rename fails to compile here
 * rather than silently zeroing the backlog probe.
 */
const CLASSIFY_MEMORIES_TASK: DreamTaskName = "classify-memories";

/**
 * Per-task activity gates (Dreamer v2 A+B). A due task runs ONLY if its gate
 * passes, so cron cadence never burns a 60-turn agentic loop on an unchanged
 * pool. Gates are conservative — allow when uncertain — and cheap (count
 * queries, no full-row loads, no LLM).
 *
 * `lastRunAt` is the task's own `task_schedule_state.last_run_at` (null = never
 * run → treat "changed since" gates as "is there anything at all").
 */

export interface TaskGateContext {
    db: Database;
    projectIdentity: string;
    lastRunAt: number | null;
    /** retrospective content watermark (max message ts scanned). Distinct from
     *  lastRunAt: a session updated mid-run is newer than its scanned content but
     *  older than the run-completion time, so gating on lastRunAt would skip it. */
    retrospectiveWatermarkMs?: number | null;
    /** review-user-memories: min candidate observations before a review is worthwhile. */
    promotionThreshold: number;
}

export function countActiveMemories(db: Database, projectPath: string): number {
    return countProjectMemoryClaims(db, {
        projectIds: resolveProjectIdsForIdentities(db, [projectPath]),
    });
}

// Lifecycle-active is not the same as runnable. `surfaceDecision` drops
// hard-hidden, contradicted, quarantined, rejected, and expired claims on every
// surface — maintenance lanes included — so counting only the lifecycle head
// reported work the runners cannot see: curate would open a child session over an
// empty pool and the backlog telemetry would never drain.
const ACTIVE_CLAIM_BASE_SQL = `
    FROM claim_public_ids cpi
    JOIN claims ON claims.id = cpi.claim_id
    JOIN claim_memory_lifecycle_heads heads
      ON heads.claim_id = claims.id AND heads.state = 'active'
   WHERE claims.project_id = ?
     AND NOT ${antiMemoryClaimSql("claims.current_revision_id")}
     AND NOT ${uniformlyAbsentClaimSql("claims.current_revision_id", "unixepoch('subsec') * 1000")}`;

/** Latest baseline assertion with `paths_state = 'known'` and at least one
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
            // Interpolation composes compile-time SQL fragments, not caller input.
            // pi-lens-ignore: sql-injection
            `SELECT COUNT(*) AS cnt ${ACTIVE_CLAIM_BASE_SQL} AND ${condition}`,
        )
        .get(...projectIds, ...conditionParams) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
}

/** Active claims whose latest baseline assertion has no `paths_state = 'known'`. */
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
 * The watermark the retrospective task should measure "new work" against.
 *
 * A null watermark makes `countProjectSessionsSince` count every session for the
 * project's lifetime, so falling back to the persisted content watermark is what
 * keeps an omitted option from reading as "no watermark". Both the activity gate
 * and the backlog probe resolve it here so they cannot disagree about how much
 * work is pending.
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
            // Interpolation composes compile-time SQL fragments, not caller input.
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
            // Interpolation composes compile-time SQL fragments, not caller input.
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
 * Active claims carrying no classify-memories evidence on their current
 * revision — the same marker `classify.ts` reads to decide what a pass still
 * has to do, so backlog telemetry falls to zero once a pass catches up.
 *
 * A revision is the unit: a revise supersedes the classified revision, and the
 * new one is genuinely unclassified again. The task prefix is bound rather than
 * inlined so the probe's SQL text names only claim tables.
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
 * Read-only backlog probe for one task. These probes reuse the task selection
 * predicates and never acquire a lease, materialize a prompt cache, or invoke a model.
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
            // With no open cycle, the next broad run will open one over the whole
            // mapped pool. Once open, report only the memories not yet verified for
            // that cycle so run telemetry reflects the resumable backlog.
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

/** Read the complete backlog breakdown in the caller's requested registry order. */
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
 * Evaluate a task's activity gate. Returns true if the task has work to do.
 * Throwing DB errors propagate to the caller (a gate that can't read is a real
 * problem, not silently "no work").
 */
export function evaluateTaskGate(task: DreamTaskName, ctx: TaskGateContext): boolean {
    const { db, projectIdentity: project, lastRunAt } = ctx;
    switch (task) {
        case "map-memories":
            // Runs only while UNMAPPED active memories exist — the one-time-style
            // backfill that drains the pool then no-ops. Cheap: a single NOT-IN
            // count against the verification side-table.
            return countUnmappedActiveMemories(db, project) > 0;

        case "verify":
            // The executor's file gate does the precise incremental partition; the
            // scheduler only avoids taking the memory lease when there is no pool.
            return countActiveMemories(db, project) > 0;

        case "verify-broad":
            // Keep an open cycle runnable even when another task removed the last
            // active memory; the executor then closes the now-empty cycle. A closed
            // cycle still needs an active pool before taking the memory lease.
            return (
                getTaskScheduleState(db, project, "verify-broad")?.lastBroadRunAt != null ||
                countActiveMemories(db, project) > 0
            );

        case "curate":
            // Curate is whole-pool hygiene, but still needs an active pool before
            // taking the shared memory lease.
            return countActiveMemories(db, project) > 0;

        case "compress-cues":
            // Cheap pre-gate: only take the memory lease when a pool exists. The
            // executor's selectCandidates does the precise NULL/stale-hash cue
            // partition and no-ops when everything is already compressed.
            return countActiveMemories(db, project) > 0;

        case "classify-memories":
            // Classification scores the active project memory pool directly. It has
            // no file gate, watermark, or completeness prerequisites.
            return countActiveMemories(db, project) > 0;

        case "retrospective":
            // Cheap pre-gate: any project session updated since the CONTENT
            // watermark (max message ts actually scanned), not lastRunAt — a
            // session updated mid-run would otherwise be skipped. The executor's
            // raw provider does the precise typed-user-message scan and bails
            // before any child session if empty. Never-run → "sessions exist".
            //
            // Falls back to the persisted watermark for the same reason
            // `getDreamTaskBacklog` does: a null watermark makes
            // `countProjectSessionsSince` count every session for the project's
            // lifetime, so a caller that omits the field would keep admitting
            // runs whose executor then finds nothing new. Every current caller
            // supplies it; resolving it here keeps the gate and the backlog
            // probe from drifting apart if one ever stops.
            return (
                countPendingCorrectionEvents(db, project) > 0 ||
                countProjectSessionsSince(
                    db,
                    project,
                    resolveRetrospectiveWatermark(db, project, ctx.retrospectiveWatermarkMs),
                ) > 0
            );

        case "maintain-docs":
            // New compartments since the last maintain-docs run. Never-run → any exist.
            return countCompartmentsSince(db, project, lastRunAt ?? 0) > 0;

        case "evaluate-smart-notes":
            return (
                getSmartNotesNeedingCompilation(db, project, Date.now(), 1).length > 0 ||
                getStaleCompiledSmartNotes(db, project, Date.now(), 1).length > 0 ||
                getPendingSmartNotes(db, project).some((note) => note.checkStatus === "fallback")
            );

        case "review-user-memories":
            // Candidate observations are GLOBAL (cross-project user profile).
            return getUserMemoryCandidates(db).length >= ctx.promotionThreshold;

        case "promote-primers": {
            if (countPrimerCandidatesForProject(db, project) >= (ctx.promotionThreshold ?? 2)) {
                return true;
            }
            // The promotion pass also owns re-embedding primers and candidates
            // whose vectors were produced under a retired provider identity —
            // search skips those vectors outright, so a project with active
            // primers but too few candidates would otherwise keep semantic
            // primer retrieval disabled indefinitely. Open the gate when stale
            // rows exist. The check is a pure SQL EXISTS (no BLOB decode) per
            // this module's cheap-gate contract, and deliberately NARROWER than
            // reembedStalePrimerEmbeddings' staleness rule: rows with NO
            // embedding at all stay under the threshold gate above. An
            // unregistered project has no current identity to compare against
            // (and nobody searching it); it stays closed until registration.
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
