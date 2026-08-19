import type { Database } from "../../../shared/sqlite";
import { getLeaseHolder, peekLeaseHolderAndExpiry } from "../dreamer/lease";
import { leaseKeyFor } from "../dreamer/task-registry";
import { createSmartNoteCapabilities } from "./capabilities";
import {
    lifecycleStateFromNote,
    applySmartNoteReduction,
    reduceSmartNoteEvaluation,
} from "./evaluation-state";
import { evaluateSmartNotePhase } from "./evaluator";
import { runCompiledSmartNoteCheck } from "./sandbox-runner";
import {
    commitSmartNoteState,
    getDueCompiledSmartNoteChecks,
    smartNoteCommitExpectation,
} from "./storage";
import { wakePlaneStatus } from "./wake-plane";

export interface RunDueCompiledSmartNoteChecksArgs {
    db: Database;
    projectIdentity: string;
    projectRoot: string;
    now?: number;
    maxChecks?: number;
    sweepBudgetMs?: number;
    leaseHeld?: () => boolean;
    signal?: AbortSignal;
    retinaHandoff?: boolean;
}

export interface RunDueCompiledSmartNoteChecksResult {
    ran: number;
    surfaced: number;
    failed: number;
    networkFailed: number;
}

function inferEvaluateSmartNotesLeaseHeld(
    db: Database,
    projectIdentity: string,
): (() => boolean) | undefined {
    const leaseKey = leaseKeyFor("evaluate-smart-notes", projectIdentity);
    const holderId = getLeaseHolder(db, leaseKey);
    if (!holderId || !peekLeaseHolderAndExpiry(db, holderId, leaseKey)) return undefined;
    return () => peekLeaseHolderAndExpiry(db, holderId, leaseKey);
}

const DEFAULT_MAX_CHECKS = 10;
const DEFAULT_SWEEP_BUDGET_MS = 15_000;

export async function runDueCompiledSmartNoteChecks(
    args: RunDueCompiledSmartNoteChecksArgs,
): Promise<RunDueCompiledSmartNoteChecksResult> {
    if ((await wakePlaneStatus()) === "present") {
        return { ran: 0, surfaced: 0, failed: 0, networkFailed: 0 };
    }

    const startedAt = Date.now();
    const now = args.now ?? startedAt;
    const due = getDueCompiledSmartNoteChecks(
        args.db,
        args.projectIdentity,
        now,
        args.maxChecks ?? DEFAULT_MAX_CHECKS,
        args.retinaHandoff,
    );
    let ran = 0;
    let surfaced = 0;
    let failed = 0;
    let networkFailed = 0;
    const leaseHeld =
        args.leaseHeld ?? inferEvaluateSmartNotesLeaseHeld(args.db, args.projectIdentity);

    for (const note of due) {
        if (Date.now() - startedAt >= (args.sweepBudgetMs ?? DEFAULT_SWEEP_BUDGET_MS)) break;
        if (!note.compiledCheck) continue;
        ran++;
        const controller = new AbortController();
        const abortFromCaller = () => controller.abort(args.signal?.reason);
        if (args.signal?.aborted) abortFromCaller();
        else args.signal?.addEventListener("abort", abortFromCaller, { once: true });
        const remaining = Math.max(
            500,
            (args.sweepBudgetMs ?? DEFAULT_SWEEP_BUDGET_MS) - (Date.now() - startedAt),
        );
        const timer = setTimeout(
            () => controller.abort(new Error("smart-note sweep budget exhausted")),
            remaining,
        );
        try {
            const evaluated = await evaluateSmartNotePhase(
                {
                    phase: "due",
                    noteId: note.id,
                    content: note.content,
                    surfaceCondition: note.surfaceCondition,
                    compiledCheck: note.compiledCheck,
                },
                {
                    compile: () => Promise.reject(new Error("due phase does not compile")),
                    confirmFallback: () => Promise.resolve(null),
                    runCompiled: (compiledCheck) =>
                        runCompiledSmartNoteCheck({
                            compiledCheck,
                            capabilityFactory: (signal) =>
                                createSmartNoteCapabilities({
                                    projectRoot: args.projectRoot,
                                    signal,
                                }),
                            signal: controller.signal,
                            timeoutMs: Math.min(2_000, remaining),
                        }),
                },
            );
            if (!evaluated.ok) {
                continue;
            }
            // Cron search is bounded and completed before the write lock so
            // schedule evaluation cannot extend the state transaction.
            const reduction = reduceSmartNoteEvaluation(
                lifecycleStateFromNote(note),
                evaluated.outcome,
                { noteId: note.id, now: Date.now() },
            );
            const committed = commitSmartNoteState(args.db, {
                phase: `due check (${evaluated.outcome.kind})`,
                expected: smartNoteCommitExpectation(note),
                leaseHeld,
                write: () => applySmartNoteReduction(args.db, note.id, reduction),
            });
            if (!committed) continue;
            if (evaluated.outcome.kind === "met") surfaced++;
            else if (evaluated.outcome.kind === "logic_failed") failed++;
            else if (evaluated.outcome.kind === "network_failed") networkFailed++;
        } finally {
            clearTimeout(timer);
            args.signal?.removeEventListener("abort", abortFromCaller);
        }
    }

    return { ran, surfaced, failed, networkFailed };
}
