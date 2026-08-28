import path from "node:path";

import type { Database } from "../../../shared/sqlite";
import {
    readGitChangedFilesSince,
    readGitFileChangeTimesSince,
    readGitHead,
    resolveGitTopLevel,
    verificationFileExists,
} from "../memory";
import { APPLICABILITY_BASELINE_STREAM_KEY } from "../storage-claim-applicability-schema";
import { readDreamerProjectClaims } from "./claim-manifest";
import { runLeaseGuardedWrite } from "./lease";
import { getTaskScheduleState, writeTaskScheduleState } from "./storage-task-schedule";
import type { VerifyPromptMemory } from "./verify-prompt";

export interface VerifyGateResult {
    runStartedAt: number;
    mode: "non-git" | "full" | "broad" | "incremental";
    inScope: VerifyPromptMemory[];
    inScopeIds: string[];
    skippedIds: string[];
    reason: string;
    broadCycleStartAt?: number;
}

function minOf(values: readonly number[]): number {
    return values.reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
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
        writeTaskScheduleState(args.db, { ...latest, lastBroadRunAt: args.runStartedAt });
        return args.runStartedAt;
    });
}

function mappedFiles(claim: ReturnType<typeof readDreamerProjectClaims>[number]): string[] {
    const baseline = claim.applicability.find(
        (assertion) => assertion.streamKey === APPLICABILITY_BASELINE_STREAM_KEY,
    );
    if (baseline?.pathsState !== "known") return [];
    return baseline.paths
        .flatMap((entry) => (entry.kind === "exact" ? [entry.value] : []))
        .sort((left, right) => left.localeCompare(right));
}

function verifiedAt(claim: ReturnType<typeof readDreamerProjectClaims>[number]): number {
    return claim.verification.latestOutcome === "verified" ? claim.verification.verifiedAt : 0;
}

function toPromptMemory(
    claim: ReturnType<typeof readDreamerProjectClaims>[number],
): VerifyPromptMemory {
    return {
        publicClaimId: claim.publicClaimId,
        revisionLocator: claim.revisionLocator,
        contentDigest: claim.contentDigest,
        mutationToken: claim.mutationToken,
        category: claim.category,
        content: claim.content,
        mappedFiles: mappedFiles(claim),
    };
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
    const active = readDreamerProjectClaims(args.db, args.projectIdentity, "verification");
    const candidates = active.filter((claim) => mappedFiles(claim).length > 0);

    if (args.forceBroad) {
        const broadCycleStartAt = ensureBroadCycleStart({ ...args, runStartedAt });
        const broadCandidates = candidates
            .filter((claim) => verifiedAt(claim) < broadCycleStartAt)
            .sort(
                (left, right) =>
                    verifiedAt(left) - verifiedAt(right) ||
                    left.publicClaimId.localeCompare(right.publicClaimId),
            );
        const inScopeIds = new Set(broadCandidates.map((claim) => claim.publicClaimId));
        return {
            runStartedAt,
            mode: "broad",
            inScope: broadCandidates.map(toPromptMemory),
            inScopeIds: [...inScopeIds],
            skippedIds: candidates.flatMap((claim) =>
                inScopeIds.has(claim.publicClaimId) ? [] : [claim.publicClaimId],
            ),
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
            reason: "no file-mapped claims in scope",
        };
    }

    const allInScope = (mode: VerifyGateResult["mode"], reason: string): VerifyGateResult => ({
        runStartedAt,
        mode,
        inScope: candidates.map(toPromptMemory),
        inScopeIds: candidates.map((claim) => claim.publicClaimId),
        skippedIds: [],
        reason,
    });
    const gitRoot =
        (await resolveGitTopLevel(args.projectDirectory)) ?? path.resolve(args.projectDirectory);
    const verifiedTimes = candidates.map(verifiedAt).filter((time) => time > 0);
    const sinceMs = verifiedTimes.length > 0 ? minOf(verifiedTimes) : runStartedAt;
    const changeTimes = await readGitFileChangeTimesSince(args.projectDirectory, sinceMs);
    if (changeTimes === null) {
        return allInScope("full", "git change-times unavailable; full verification");
    }
    const head = await readGitHead(args.projectDirectory);
    const uncommitted = head
        ? ((await readGitChangedFilesSince(args.projectDirectory, head)) ?? new Set<string>())
        : new Set<string>();

    const inScope: VerifyPromptMemory[] = [];
    const skippedIds: string[] = [];
    for (const claim of candidates) {
        const lastVerifiedAt = verifiedAt(claim);
        if (lastVerifiedAt === 0) {
            inScope.push(toPromptMemory(claim));
            continue;
        }
        const needsVerification = mappedFiles(claim).some(
            (file) =>
                !verificationFileExists(gitRoot, file) ||
                uncommitted.has(file) ||
                (changeTimes.get(file) ?? 0) >= lastVerifiedAt - 1_000,
        );
        if (needsVerification) inScope.push(toPromptMemory(claim));
        else skippedIds.push(claim.publicClaimId);
    }
    return {
        runStartedAt,
        mode: "incremental",
        inScope,
        inScopeIds: inScope.map((claim) => claim.publicClaimId),
        skippedIds,
        reason: `incremental verification (${inScope.length} changed of ${candidates.length} mapped)`,
    };
}
