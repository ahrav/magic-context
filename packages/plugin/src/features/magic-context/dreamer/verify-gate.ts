import path from "node:path";

import type { Database } from "../../../shared/sqlite";
import {
    getMemoriesByProject,
    getMemoryVerifications,
    readGitChangedFilesSince,
    readGitFileChangeTimesSince,
    readGitHead,
    resolveGitTopLevel,
    verificationFileExists,
} from "../memory";
import { filterMemoriesByPolicy } from "../memory/storage-claim-visibility";
import { runLeaseGuardedWrite } from "./lease";
import { getTaskScheduleState, writeTaskScheduleState } from "./storage-task-schedule";
import type { VerifyPromptMemory } from "./verify-prompt";

/**
 * Per-memory verify scope (DreamerV2 rework).
 *
 * Replaces the old GLOBAL commit-watermark + all-or-nothing coverage gate. Now
 * each memory carries its own `verified_at` (set by the verify apply), so:
 *  - partial progress STICKS: a timed-out verify banks the memories it checked;
 *    the next run skips them and continues (the cold-start trap is gone).
 *  - there is no watermark to advance and no coverage check.
 *
 * Scope = active memories that have a REAL backing-file mapping (recorded by the
 * map-memories backfill). Excluded:
 *  - file-independent memories (no-file sentinel) — they describe external
 *    behavior and cannot be checked against local code; curate + age decay own
 *    them.
 *  - unmapped memories — map-memories maps them first; once mapped they enter
 *    verify scope as never-verified (verified_at = 0).
 *
 * Modes:
 *  - `verify` (incremental, default): a candidate is in scope if it was never
 *    content-verified (verified_at = 0) OR any mapped file changed since THAT
 *    memory's verified_at (committed change-time newer, an uncommitted edit, or
 *    the file was deleted).
 *  - `verify-broad` (`forceBroad`): candidates whose `verified_at` predates the
 *    currently open broad cycle. The cycle start is persisted in the existing
 *    `last_broad_run_at` schedule-state column, so a large pool drains oldest-first
 *    across scheduled runs instead of being selected afresh every week.
 */

export interface VerifyGateResult {
    runStartedAt: number;
    mode: "non-git" | "full" | "broad" | "incremental";
    inScope: VerifyPromptMemory[];
    inScopeIds: number[];
    skippedIds: number[];
    reason: string;
    /** The persisted broad-cycle watermark used for this run, when broad. */
    broadCycleStartAt?: number;
}

/** Min of a numeric list without spread (avoids RangeError on large pools). */
function minOf(values: readonly number[]): number {
    return values.reduce((acc, v) => (v < acc ? v : acc), Number.POSITIVE_INFINITY);
}

function ensureBroadCycleStart(args: {
    db: Database;
    projectIdentity: string;
    holderId?: string;
    leaseKey?: string;
    runStartedAt: number;
}): number {
    const current = getTaskScheduleState(args.db, args.projectIdentity, "verify-broad");
    if (current?.lastBroadRunAt != null && current.lastBroadRunAt > 0) {
        return current.lastBroadRunAt;
    }
    // Direct gate callers without a scheduler row have no schedule state to
    // persist. Production runs are seeded by the scheduler and take the guarded
    // path below; retaining this fallback keeps the gate useful in isolated tests
    // and for old callers that do not use Dreamer v2 scheduling.
    if (!current) return args.runStartedAt;
    if (!args.holderId || !args.leaseKey) {
        throw new Error("verify-broad cycle opening requires the task lease");
    }

    return runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
        const latest = getTaskScheduleState(args.db, args.projectIdentity, "verify-broad");
        if (!latest) return args.runStartedAt;
        if (latest.lastBroadRunAt != null && latest.lastBroadRunAt > 0) {
            return latest.lastBroadRunAt;
        }
        writeTaskScheduleState(args.db, {
            ...latest,
            lastBroadRunAt: args.runStartedAt,
        });
        return args.runStartedAt;
    });
}

export async function partitionVerifyScope(args: {
    db: Database;
    projectIdentity: string;
    projectDirectory: string;
    forceBroad?: boolean;
    now?: number;
    holderId?: string;
    leaseKey?: string;
}): Promise<VerifyGateResult> {
    const runStartedAt = args.now ?? Date.now();
    // Verification is the ladder step that PRODUCES the VERIFIED rung, so its
    // pool keeps candidate/stale/disputed rows and excludes only the
    // uniform-absence class (hard-hidden and rejected): those must not reach
    // any agent surface, child-model prompts included.
    const active = filterMemoriesByPolicy(
        args.db,
        getMemoriesByProject(args.db, args.projectIdentity),
        "explicit_search",
    ).memories;
    const verById = getMemoryVerifications(
        args.db,
        active.map((m) => m.id),
    );

    // Candidates: active memories WITH a real backing-file mapping. A memory with
    // only the no-file sentinel (file-independent) or no mapping row at all is
    // excluded — see the doc comment.
    const candidates = active.filter((m) => (verById.get(m.id)?.files.length ?? 0) > 0);

    const toPrompt = (m: (typeof active)[number]): VerifyPromptMemory => ({
        id: m.id,
        category: m.category,
        content: m.content,
        mappedFiles: verById.get(m.id)?.files ?? [],
    });

    if (args.forceBroad) {
        const broadCycleStartAt = ensureBroadCycleStart({
            db: args.db,
            projectIdentity: args.projectIdentity,
            holderId: args.holderId,
            leaseKey: args.leaseKey,
            runStartedAt,
        });
        const broadCandidates = candidates
            .filter((m) => (verById.get(m.id)?.verifiedAt ?? 0) < broadCycleStartAt)
            .sort((a, b) => {
                const verifiedAtA = verById.get(a.id)?.verifiedAt ?? 0;
                const verifiedAtB = verById.get(b.id)?.verifiedAt ?? 0;
                return verifiedAtA - verifiedAtB || a.id - b.id;
            });
        return {
            runStartedAt,
            mode: "broad",
            inScope: broadCandidates.map(toPrompt),
            inScopeIds: broadCandidates.map((m) => m.id),
            skippedIds: candidates
                .filter((m) => !broadCandidates.some((candidate) => candidate.id === m.id))
                .map((m) => m.id),
            broadCycleStartAt,
            reason: `broad cycle (${broadCandidates.length} remain; started ${broadCycleStartAt})`,
        };
    }

    if (candidates.length === 0) {
        return {
            runStartedAt,
            mode: "incremental",
            inScope: [],
            inScopeIds: [],
            skippedIds: [],
            reason: "no file-mapped memories in scope",
        };
    }

    const allInScope = (mode: VerifyGateResult["mode"], reason: string): VerifyGateResult => ({
        runStartedAt,
        mode,
        inScope: candidates.map(toPrompt),
        inScopeIds: candidates.map((m) => m.id),
        skippedIds: [],
        reason,
    });

    const gitRoot =
        (await resolveGitTopLevel(args.projectDirectory)) ?? path.resolve(args.projectDirectory);

    // Oldest verified time among already-verified candidates bounds the git-log
    // window. Never-verified candidates (verified_at = 0) are always in scope.
    const verifiedTimes = candidates
        .map((m) => verById.get(m.id)?.verifiedAt ?? 0)
        .filter((t) => t > 0);
    const sinceMs = verifiedTimes.length > 0 ? minOf(verifiedTimes) : runStartedAt;

    const changeTimes = await readGitFileChangeTimesSince(args.projectDirectory, sinceMs);
    if (changeTimes === null) {
        // git unavailable → verify everything (safe direction: re-check vs skip).
        return allInScope("full", "git change-times unavailable; full verification");
    }
    // Also catch uncommitted working-tree edits (committed change-times miss them):
    // a mapped file with a pending edit is "changed now" → re-verify.
    const head = await readGitHead(args.projectDirectory);
    const uncommitted = head
        ? ((await readGitChangedFilesSince(args.projectDirectory, head)) ?? new Set<string>())
        : new Set<string>();

    const inScope: VerifyPromptMemory[] = [];
    const skippedIds: number[] = [];
    for (const m of candidates) {
        const v = verById.get(m.id);
        const verifiedAt = v?.verifiedAt ?? 0;
        if (verifiedAt === 0) {
            inScope.push(toPrompt(m)); // never content-verified
            continue;
        }
        const files = v?.files ?? [];
        const needs = files.some(
            (file) =>
                !verificationFileExists(gitRoot, file) || // deleted → re-check
                uncommitted.has(file) || // pending working-tree edit
                (changeTimes.get(file) ?? 0) >= verifiedAt - 1_000, // git commit times are second-granular
        );
        if (needs) inScope.push(toPrompt(m));
        else skippedIds.push(m.id);
    }

    return {
        runStartedAt,
        mode: "incremental",
        inScope,
        inScopeIds: inScope.map((m) => m.id),
        skippedIds,
        reason: `incremental verification (${inScope.length} changed of ${candidates.length} mapped)`,
    };
}
