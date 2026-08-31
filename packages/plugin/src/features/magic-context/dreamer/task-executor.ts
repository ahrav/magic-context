import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import {
    DREAMER_AGENT,
    DREAMER_DOCS_AGENT,
    DREAMER_RETROSPECTIVE_AGENT,
} from "../../../agents/dreamer";
import { withContentLanguageDirective } from "../../../agents/language-directive";
import type { DreamingTask } from "../../../config/schema/magic-context";
import {
    childSessionMessagesFetcher,
    createChildSessionWithFence,
} from "../../../hooks/magic-context/child-session-spawn";
import type { RawMessageProvider } from "../../../hooks/magic-context/read-session-chunk";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { describeError } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { getCompartmentEvents } from "../compartment-events";
import type {
    CanonicalJsonValue,
    ClaimOperationResultEffect,
} from "../memory/claim-operation-contract";
import {
    type AutonomousManifestIdentity,
    combineClaimOperationStageOutcomes,
    runAutonomousManifestInCurrentTransaction,
} from "../memory/storage-claim-autonomous";
import type { ProjectMemoryClaimSnapshot } from "../memory/storage-claim-current-state";
import { censusProjectMemoryClaims } from "../memory/storage-claim-current-state";
import {
    stageCreateProjectMemoryClaimInCurrentTransaction,
    stageMergeProjectMemoryClaimsInCurrentTransaction,
    stageReviseProjectMemoryClaimInCurrentTransaction,
    stageSetProjectMemoryClaimLifecycleInCurrentTransaction,
} from "../memory/storage-claim-operations";
import { ensureProject } from "../memory/storage-claims";
import { runCompressCues } from "../mural/compress-cues";
import { recordChildInvocation } from "../subagent-token-capture";
import { reviewUserMemories } from "../user-memory/review-user-memories";
import { getActiveUserMemories } from "../user-memory/storage-user-memory";
import { harvestAntiMemoriesFromCorrections } from "./anti-memory-from-corrections";
import {
    claimManifestBinding,
    dreamerInferenceProvenance,
    dreamerManifestIdentity,
    readDreamerProjectClaims,
    recordDreamerManifestRejection,
} from "./claim-manifest";
import { type ClassifyModuleClient, runClassify } from "./classify";
import { evaluateSmartNotes } from "./evaluate-smart-notes";
import {
    acquireLeaseWithAcquisition,
    type LeaseAcquisition,
    leaseOwnershipMatches,
    runLeaseGuardedWrite,
    startLeaseHeartbeat,
} from "./lease";
import {
    enforceMaintainDocsProtectedRegions,
    snapshotMaintainDocsFiles,
} from "./maintain-docs-protected-enforcement";
import { mapMemories } from "./map-memories";
import { DreamerModuleFailureError, resolveDreamerModuleRoute } from "./module-apply";
import { promotePrimers } from "./promote-primers";
import { refreshPrimers } from "./refresh-primers";
import {
    applyRetrospectiveLearnings,
    parseRetrospectiveLearnings,
} from "./retrospective-learnings";
import {
    type RetrospectiveRawMessage,
    type RetrospectiveRawProvider,
    readRetrospectiveScanWindow,
} from "./retrospective-raw-provider";
import {
    claimEffectMemoryChanges,
    type DreamRunMemoryChanges,
    insertDreamRun,
} from "./storage-dream-runs";
import {
    getTaskScheduleState,
    isRetrospectiveWindowProcessed,
    recordRetrospectiveWindowProcessed,
} from "./storage-task-schedule";
import { buildClassifyModelChain } from "./task-config";
import { getDreamTaskBacklog } from "./task-gates";
import {
    buildDreamTaskPrompt,
    buildFrictionGatePrompt,
    buildRetrospectivePrompt,
    CURATE_SYSTEM_PROMPT,
    type CurateManifestAction,
    type CuratePromptMemory,
    FRICTION_GATE_SYSTEM_PROMPT,
    MAINTAIN_DOCS_SYSTEM_PROMPT,
    RETROSPECTIVE_SYSTEM_PROMPT,
    type RetrospectivePromptEvent,
    validateCurateManifest,
} from "./task-prompts";
import {
    type DreamTaskName,
    type DreamTaskProgress,
    type DreamTaskRunBacklog,
    processedDreamTaskItems,
} from "./task-registry";
import type {
    DreamTaskRuntimeConfig,
    TaskExecOutcome,
    TaskExecutor,
    TaskExecutorContext,
} from "./task-scheduler";
import { runVerify } from "./verify";

export interface DreamTaskExecutorDeps {
    client: PluginContext["client"];
    /** The drain uses `sessionDirectory` as its filesystem directory, not as its project identity. */
    sessionDirectory: string;
    /**
     * `openOpenCodeDb` opens the OpenCode DB read-only for key-files candidate scans. The dream-timer resolves its path and returns null when unavailable. */
    openOpenCodeDb: () => Database | null;
    retrospectiveRawProvider?:
        | RetrospectiveRawProvider
        | ((db: Database, projectIdentity: string) => RetrospectiveRawProvider | null);
    /** The host uses `userMemoryCollectionEnabled` as the privacy gate for `route="observation"` learnings. */
    userMemoryCollectionEnabled?: boolean;
    /** The executor registers the project embedding provider before primer clustering embeds candidates. */
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void> | void;
    /**
     * `primerRawProviderFactory` lets Pi read orientation seeds from historical session JSONL.
     * `primerRawProviderFactory` lets `refresh-primers` render orientation seeds from Pi JSONL.
     * OpenCode leaves `primerRawProviderFactory` undefined so seed reads use read-only `opencode.db`.
     * A null `primerRawProviderFactory` result makes refresh use closed-book mode.
     */
    primerRawProviderFactory?: (
        sessionId: string,
    ) => Promise<RawMessageProvider | null> | RawMessageProvider | null;
    language?: string;
    /** An explicit `transformMode: "ts"` prevents Rust transformation. */
    transformMode?: "ts" | "rust";
    /** The classifier uses `dreamerModel` only after MODULE authority is confirmed. */
    dreamerModel?: string;
    mural?: { enabled: boolean; model?: string };
    memoryInjectionBudgetTokens?: number;
    retinaHandoff?: boolean;
    /** `onProgress` reports process-local status and never accesses the prompt/result cache. */
    onProgress?: (progress: DreamTaskProgress | null, completedTask?: DreamTaskName) => void;
    curateLifecycle?: {
        beforePrompt?: () => Promise<void> | void;
        afterPrompt?: (declareLeaseLost: () => void) => Promise<void> | void;
    };
    moduleClient?: ClassifyModuleClient & {
        authorityStatus?: (args: {
            context_store_uuid: string;
            project: string;
            projectRoot?: string;
            domain: "memories" | "notes";
        }) => Promise<{ authority: { state?: string; generation?: number } | null }>;
    };
}

/** Failed tasks hot-retry transient provider, network, rate-limit, timeout, abort, lease, and busy errors.
 * Permanent model-not-found, validation, and parse failures advance to the next cron slot.
 * */
function classifyFailure(error: unknown): { transient: boolean; brief: string } {
    const described = describeError(error);
    const brief = described.brief;
    const name = error instanceof Error ? error.name : "";
    const explicitTransient =
        error !== null &&
        typeof error === "object" &&
        (error as { transient?: unknown }).transient === true;
    const combined = `${name} ${brief}`.toLowerCase();
    const transient =
        explicitTransient ||
        name === "AbortError" ||
        /abort|lease|timeout|timed out|econn|socket|network|rate.?limit|429|503|overloaded|sqlite_busy|database is locked/.test(
            combined,
        );
    return { transient, brief };
}

function newIds(beforeIds: number[], afterIds: number[]): number[] {
    const before = new Set(beforeIds);
    return afterIds.filter((id) => !before.has(id));
}

function toCuratePromptMemory(claim: ProjectMemoryClaimSnapshot): CuratePromptMemory {
    const paths = claim.applicability.flatMap((assertion) =>
        assertion.paths.map((path) => path.value),
    );
    return {
        publicClaimId: claim.publicClaimId,
        revisionLocator: claim.revisionLocator,
        contentDigest: claim.contentDigest,
        category: claim.category,
        content: claim.content,
        mappedFiles: [...new Set(paths)],
        hasNoFileSentinel: claim.applicability.some(
            (assertion) => assertion.pathsState === "known" && assertion.paths.length === 0,
        ),
    };
}

function loadCurateClaims(db: Database, projectIdentity: string): ProjectMemoryClaimSnapshot[] {
    return readDreamerProjectClaims(db, projectIdentity, "hygiene");
}

function curateActionIds(action: CurateManifestAction): string[] {
    return action.kind === "merge"
        ? [action.targetPublicClaimId, ...action.sourcePublicClaimIds]
        : [action.publicClaimId];
}

function curateManifestValue(action: CurateManifestAction): CanonicalJsonValue {
    switch (action.kind) {
        case "keep":
            return { kind: action.kind, publicClaimId: action.publicClaimId };
        case "update":
            return {
                content: action.content,
                kind: action.kind,
                publicClaimId: action.publicClaimId,
            };
        case "archive":
            return {
                kind: action.kind,
                publicClaimId: action.publicClaimId,
                reason: action.reason,
            };
        case "merge":
            return {
                content: action.content,
                kind: action.kind,
                sourcePublicClaimIds: action.sourcePublicClaimIds,
                targetPublicClaimId: action.targetPublicClaimId,
            };
        case "split":
            return {
                content: action.content,
                created: action.created.map((item) => ({
                    category: item.category,
                    content: item.content,
                })),
                kind: action.kind,
                publicClaimId: action.publicClaimId,
            };
    }
}

export function applyCurateManifest(args: {
    db: Database;
    projectIdentity: string;
    claims: readonly ProjectMemoryClaimSnapshot[];
    identity: AutonomousManifestIdentity;
    manifestText: string;
}) {
    const actions = validateCurateManifest(
        args.manifestText,
        new Set(args.claims.map((claim) => claim.publicClaimId)),
    );
    const byId = new Map(args.claims.map((claim) => [claim.publicClaimId, claim]));
    const projectId = ensureProject(args.db, args.projectIdentity);
    return runAutonomousManifestInCurrentTransaction({
        db: args.db,
        identity: args.identity,
        items: actions.map((action) => {
            const ids = curateActionIds(action);
            const claims = ids.map((id) => {
                const claim = byId.get(id);
                if (!claim) throw new Error(`curate returned unknown claim ${id}`);
                return claim;
            });
            const [primary, ...additional] = claims;
            if (!primary) throw new Error("curate action has no bound claim");
            return {
                binding: claimManifestBinding(primary),
                additionalBindings: additional.map(claimManifestBinding),
                value: action,
            };
        }),
        manifest: actions.map(curateManifestValue),
        resultSummary: {
            archived: actions.filter((action) => action.kind === "archive").length,
            merged: actions.filter((action) => action.kind === "merge").length,
            split: actions.filter((action) => action.kind === "split").length,
            updated: actions.filter((action) => action.kind === "update").length,
        },
        stageItem: (db, item, nowMs) => {
            const action = item.value;
            const provenance = (content: string, suffix = "") =>
                dreamerInferenceProvenance({
                    identity: args.identity,
                    binding: item.binding,
                    sourceContent: `${content}${suffix}`,
                });
            if (action.kind === "keep") {
                return { kind: "noop", payload: { kind: "kept", claim: action.publicClaimId } };
            }
            if (action.kind === "update") {
                return stageReviseProjectMemoryClaimInCurrentTransaction(
                    db,
                    {
                        token: item.binding.token,
                        content: action.content,
                        provenance: provenance(action.content),
                        actor: args.identity.producer,
                    },
                    nowMs,
                );
            }
            if (action.kind === "archive") {
                return stageSetProjectMemoryClaimLifecycleInCurrentTransaction(
                    db,
                    {
                        token: item.binding.token,
                        state: "archived",
                        reason: action.reason,
                        actor: args.identity.producer,
                    },
                    nowMs,
                );
            }
            if (action.kind === "merge") {
                return stageMergeProjectMemoryClaimsInCurrentTransaction(
                    db,
                    {
                        targetToken: item.binding.token,
                        sourceTokens: (item.additionalBindings ?? []).map(
                            (binding) => binding.token,
                        ),
                        mergedContent: action.content,
                        actor: args.identity.producer,
                    },
                    nowMs,
                );
            }
            const outcomes = [
                stageReviseProjectMemoryClaimInCurrentTransaction(
                    db,
                    {
                        token: item.binding.token,
                        content: action.content,
                        provenance: provenance(action.content, ":kept"),
                        actor: args.identity.producer,
                    },
                    nowMs,
                ),
                ...action.created.map((created, index) =>
                    stageCreateProjectMemoryClaimInCurrentTransaction(
                        db,
                        {
                            projectId,
                            category: created.category,
                            content: created.content,
                            provenance: provenance(created.content, `:split:${index}`),
                            actor: args.identity.producer,
                            nowMs,
                        },
                        nowMs,
                    ),
                ),
            ];
            return combineClaimOperationStageOutcomes(outcomes, {
                created: action.created.length,
                kind: "split",
            });
        },
    });
}

/**
 * The scheduler supplies the keyed lease and holderId; the executor renews the lease, aborts on lease loss, and writes one `dream_runs` row.
 */
export function createDreamTaskExecutor(deps: DreamTaskExecutorDeps): TaskExecutor {
    // A shared `session.list` promise makes concurrent callers await the same populated parent session.
    let parentSessionIdPromise: Promise<string | undefined> | undefined;

    const resolveParentSessionId = (): Promise<string | undefined> => {
        if (!parentSessionIdPromise) {
            parentSessionIdPromise = (async () => {
                try {
                    const listResponse = await deps.client.session.list({
                        query: { directory: deps.sessionDirectory },
                    });
                    const sessions = shared.normalizeSDKResponse(
                        listResponse,
                        [] as { id?: string }[],
                        { preferResponseOnMissingData: true },
                    );
                    return sessions?.find((s) => typeof s?.id === "string")?.id;
                } catch {
                    return undefined;
                }
            })();
        }
        return parentSessionIdPromise;
    };

    return async (
        config: DreamTaskRuntimeConfig,
        ctx: TaskExecutorContext,
    ): Promise<TaskExecOutcome> => {
        const { db, projectIdentity, holderId, leaseKey } = ctx;
        const startedAt = Date.now();
        const leaseAcquisition: LeaseAcquisition =
            ctx.leaseAcquisition ??
            acquireLeaseWithAcquisition(db, holderId, leaseKey) ??
            (() => {
                throw new Error("Dream lease unavailable during executor setup");
            })();
        const deadline = startedAt + config.timeoutMinutes * 60 * 1000;
        const backlogAtStart = getDreamTaskBacklog(db, projectIdentity, config.task);
        const reportProgress = (processed: number): void => {
            deps.onProgress?.({
                task: config.task,
                processed: Math.max(0, processed),
                total: backlogAtStart.pending,
                startedAt,
            });
        };
        reportProgress(0);
        const incompleteMessage = (remaining: number): string => {
            const processed = processedDreamTaskItems(backlogAtStart.pending, remaining);
            return `${config.task} incomplete: ${remaining} remain (was ${backlogAtStart.pending} at run start; processed ${processed} this run)`;
        };
        const parent = await resolveParentSessionId();
        let moduleRoute: Awaited<ReturnType<typeof resolveDreamerModuleRoute>>;
        if (
            config.task === "map-memories" ||
            config.task === "compress-cues" ||
            config.task === "classify-memories" ||
            config.task === "verify" ||
            config.task === "verify-broad"
        ) {
            try {
                moduleRoute = await resolveDreamerModuleRoute({
                    db,
                    projectIdentity,
                    projectRoot: deps.sessionDirectory,
                    transformMode: deps.transformMode,
                    moduleClient: deps.moduleClient,
                    commandId: `${startedAt}:${holderId}:${config.task}`,
                });
            } catch (error) {
                throw new DreamerModuleFailureError("authority.status", error);
            }
        }
        if (!leaseOwnershipMatches(db, holderId, leaseAcquisition.generation, leaseKey)) {
            throw new Error("Dream lease lost during executor setup");
        }

        const recordRun = (
            status: "completed" | "failed",
            error: string | null,
            extra?: {
                memoryChanges?: ReturnType<typeof computeMemoryDelta>;
                smartNotesSurfaced?: number;
                smartNotesPending?: number;
                /** The caller passes the cycle-local backlog because broad verification closes its cycle before telemetry is recorded.
                 * */
                backlogAfter?: { pending: number; total: number };
                /** `progress` and `detail` are persisted only for successful runs.
                 * Empty strings are omitted so absent and empty have the same persisted meaning. */
                progress?: string | null;
            },
        ): void => {
            try {
                insertDreamRun(db, {
                    projectPath: projectIdentity,
                    startedAt,
                    finishedAt: Date.now(),
                    holderId,
                    tasks: [
                        {
                            name: config.task,
                            durationMs: Date.now() - startedAt,
                            resultChars: 0,
                            ...(status === "failed" && error ? { error } : {}),
                            ...(extra?.progress ? { progress: extra.progress } : {}),
                            backlog: (() => {
                                const end =
                                    extra?.backlogAfter ??
                                    getDreamTaskBacklog(db, projectIdentity, config.task);
                                const processed = processedDreamTaskItems(
                                    backlogAtStart.pending,
                                    end.pending,
                                );
                                const value: DreamTaskRunBacklog = {
                                    pendingAtStart: backlogAtStart.pending,
                                    totalAtStart: backlogAtStart.total,
                                    pendingAtEnd: end.pending,
                                    totalAtEnd: end.total,
                                    processed,
                                };
                                return value;
                            })(),
                        },
                    ],
                    tasksSucceeded: status === "completed" ? 1 : 0,
                    tasksFailed: status === "failed" ? 1 : 0,
                    smartNotesSurfaced: extra?.smartNotesSurfaced ?? 0,
                    smartNotesPending: extra?.smartNotesPending ?? 0,
                    memoryChanges: extra?.memoryChanges ?? null,
                    parentSessionId: parent ?? null,
                });
            } catch (e) {
                log(`[dreamer] failed to record dream_run for ${config.task}: ${e}`);
            }
        };

        function computeMemoryDelta(
            before: ReturnType<typeof censusProjectMemoryClaims>,
        ): DreamRunMemoryChanges | null {
            const after = censusProjectMemoryClaims(db, projectIdentity);
            // Capture the exact changed ids — count === array length.
            // Claims are append-only, so deletedIds stays empty outside a reset;
            // "merged" reports newly retired claims (merge retires its sources).
            const writtenIds = newIds(before.ids, after.ids);
            const deletedIds = newIds(after.ids, before.ids);
            const archivedIds = newIds(before.archivedIds, after.archivedIds);
            const mergedIds = newIds(before.retiredIds, after.retiredIds);
            const changes: DreamRunMemoryChanges = {
                written: writtenIds.length,
                deleted: deletedIds.length,
                archived: archivedIds.length,
                merged: mergedIds.length,
                writtenIds,
                deletedIds,
                archivedIds,
                mergedIds,
            };
            return writtenIds.length || deletedIds.length || archivedIds.length || mergedIds.length
                ? changes
                : null;
        }

        /**
         * The executor stores committed correction-harvest effects outside `try` so failure reporting retains them.
         *
         * The harvest commits in its own lease-guarded transaction before model inference.
         */
        let committedHarvestEffects: readonly ClaimOperationResultEffect[] = [];

        try {
            if (config.task === "compress-cues") {
                if (deps.mural?.enabled !== true) {
                    // The executor logs this config-gated no-op because `/ctx-dream` would otherwise report a successful run and mask a wiring gap.
                    log("[dreamer] compress-cues: skipped (mural is not enabled)");
                    recordRun("completed", null);
                    return { status: "completed" };
                }
                // The executor selects the model in this order: task override, mural model, dreamer model, then session model.
                const result = await runCompressCues({
                    db,
                    client: deps.client,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    model: config.model ?? deps.mural.model ?? deps.dreamerModel,
                    fallbackModels: config.fallbackModels,
                    onProgress: (processed) => reportProgress(processed),
                });
                log(
                    `[dreamer] compress-cues: compressed=${result.compressed} skipped=${result.skipped} chunks=${result.chunks} remaining=${result.remaining}`,
                );
                if (!result.complete) {
                    const error = incompleteMessage(result.remaining);
                    recordRun("failed", error);
                    return { status: "failed", transient: true, error };
                }
                recordRun("completed", null);
                return { status: "completed" };
            }

            if (config.task === "review-user-memories") {
                const result = await reviewUserMemories({
                    db,
                    client: deps.client,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    promotionThreshold: config.promotionThreshold ?? 3,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    language: config.language ?? deps.language,
                });
                recordRun("completed", null, {
                    memoryChanges: claimEffectMemoryChanges(result.effects),
                });
                log(
                    `[dreamer] review-user-memories: promoted=${result.promoted} project_promoted=${result.projectPromoted} merged=${result.merged} dismissed=${result.dismissed}`,
                );
                return { status: "completed" };
            }

            if (config.task === "map-memories") {
                const result = await mapMemories({
                    db,
                    client: deps.client,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    moduleRoute,
                    onProgress: (processed) => reportProgress(processed),
                });
                log(
                    `[dreamer] map-memories: mapped=${result.mapped} independent=${result.independent} batches=${result.batches} remaining=${result.remaining}`,
                );
                if (!result.complete) {
                    const error = incompleteMessage(result.remaining);
                    recordRun("failed", error);
                    return { status: "failed", transient: true, error };
                }
                recordRun("completed", null);
                return { status: "completed" };
            }

            if (config.task === "verify" || config.task === "verify-broad") {
                const memoryBefore = censusProjectMemoryClaims(db, projectIdentity);
                const result = await runVerify({
                    db,
                    client: deps.client,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    forceBroad: config.task === "verify-broad",
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    language: config.language ?? deps.language,
                    moduleRoute,
                    onProgress: (processed) => reportProgress(processed),
                });
                const processed = result.verified + result.updated + result.archived;
                const broadProgress =
                    config.task === "verify-broad"
                        ? `verify-broad cycle ${result.broadCycleStartAt ?? "open"}: verified ${processed}, ${result.remaining} remain`
                        : null;
                const backlogAfter =
                    config.task === "verify-broad"
                        ? { pending: result.remaining, total: backlogAtStart.total }
                        : undefined;
                if (!result.complete) {
                    // A broad run succeeds when it makes progress before its deadline.
                    if (broadProgress && processed > 0) {
                        recordRun("completed", null, {
                            progress: broadProgress,
                            memoryChanges: computeMemoryDelta(memoryBefore),
                            backlogAfter,
                        });
                        return { status: "completed" };
                    }
                    const error = incompleteMessage(result.remaining);
                    recordRun("failed", error, {
                        memoryChanges: computeMemoryDelta(memoryBefore),
                        backlogAfter,
                    });
                    return { status: "failed", transient: true, error };
                }
                recordRun("completed", null, {
                    progress: broadProgress,
                    memoryChanges: computeMemoryDelta(memoryBefore),
                    backlogAfter,
                });
                return { status: "completed" };
            }

            if (config.task === "classify-memories") {
                // The metadata write updates `classified_at`, `importance`, `scope`, and `shareable` without changing memory-status counts.
                let moduleArgs:
                    | Pick<
                          import("./classify").ClassifyArgs,
                          | "moduleClient"
                          | "moduleSessionId"
                          | "moduleProjectRoot"
                          | "moduleContextStoreUuid"
                          | "moduleAuthorityGeneration"
                          | "moduleCommandId"
                      >
                    | undefined;
                if (moduleRoute) {
                    moduleArgs = {
                        moduleClient: moduleRoute.moduleClient,
                        moduleSessionId: moduleRoute.moduleSessionId,
                        moduleProjectRoot: moduleRoute.moduleProjectRoot,
                        moduleContextStoreUuid: moduleRoute.moduleContextStoreUuid,
                        moduleAuthorityGeneration: moduleRoute.moduleAuthorityGeneration,
                        moduleCommandId: moduleRoute.moduleCommandId,
                    };
                }
                const result = await runClassify({
                    db,
                    client: deps.client,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    modelChain: buildClassifyModelChain(
                        config.model,
                        deps.dreamerModel,
                        config.fallbackModels,
                    ),
                    ...moduleArgs,
                    onProgress: (processed) => reportProgress(processed),
                });
                log(
                    `[dreamer] classify-memories: stage=${result.stage} classified=${result.classified} changed=${result.changed} chunks=${result.chunks} remaining=${result.remaining}`,
                );
                if (!result.complete) {
                    const error = incompleteMessage(result.remaining);
                    recordRun("failed", error);
                    return { status: "failed", transient: true, error };
                }
                recordRun("completed", null);
                return { status: "completed" };
            }

            if (config.task === "promote-primers") {
                const result = await promotePrimers({
                    db,
                    client: deps.client,
                    projectIdentity,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    promotionThreshold: config.promotionThreshold ?? 2,
                    ensureProjectRegistered: deps.ensureProjectRegistered,
                });
                recordRun("completed", null);
                log(
                    `[dreamer] promote-primers: promoted=${result.promoted} updated=${result.updated} candidates=${result.candidates}`,
                );
                return { status: "completed" };
            }

            if (config.task === "refresh-primers") {
                const result = await refreshPrimers({
                    db,
                    client: deps.client,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    language: config.language ?? deps.language,
                    rawProviderFactory: deps.primerRawProviderFactory,
                    onProgress: (processed) => reportProgress(processed),
                });
                recordRun("completed", null);
                log(
                    `[dreamer] refresh-primers: refreshed=${result.refreshed} skipped=${result.skipped}`,
                );
                return { status: "completed" };
            }

            if (config.task === "evaluate-smart-notes") {
                const result = await evaluateSmartNotes({
                    db,
                    client: deps.client,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    leaseAcquisition,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                    retinaHandoff: deps.retinaHandoff,
                });
                recordRun("completed", null, {
                    smartNotesSurfaced: result.surfaced,
                    smartNotesPending: result.pending,
                });
                return { status: "completed" };
            }

            if (config.task === "retrospective") {
                const memoryBefore = censusProjectMemoryClaims(db, projectIdentity);
                const correctionHarvest = runLeaseGuardedWrite(
                    db,
                    holderId,
                    leaseKey,
                    () => harvestAntiMemoriesFromCorrections({ db, projectIdentity }),
                    leaseAcquisition.generation,
                );
                if (!correctionHarvest) {
                    throw new Error("Dream lease lost during trajectory-correction harvest");
                }
                committedHarvestEffects = correctionHarvest.effects;
                const retro = await runRetrospectiveTask(config, ctx, {
                    deps,
                    deadline,
                    parent,
                    invocationStartedAt: startedAt,
                });
                recordRun("completed", null, {
                    memoryChanges:
                        claimEffectMemoryChanges([
                            ...correctionHarvest.effects,
                            ...retro.effects,
                        ]) ?? computeMemoryDelta(memoryBefore),
                });
                return {
                    status: "completed",
                    schedulePatch:
                        retro.retrospectiveWatermarkMs != null
                            ? { retrospectiveWatermarkMs: retro.retrospectiveWatermarkMs }
                            : undefined,
                };
            }

            return await runAgenticTask(config, ctx, {
                deps,
                deadline,
                parent,
                recordRun,
                computeMemoryDelta,
            });
        } catch (error) {
            const { transient, brief } = classifyFailure(error);
            // `recordRun` reports committed harvest effects because receipt deduplication prevents retries from rediscovering their events.
            const harvested = claimEffectMemoryChanges([...committedHarvestEffects]);
            recordRun("failed", brief, harvested ? { memoryChanges: harvested } : undefined);
            log(`[dreamer] task ${config.task} failed (transient=${transient}): ${brief}`);
            return { status: "failed", transient, error: brief };
        } finally {
            deps.onProgress?.(null, config.task);
        }
    };
}

function resolveRetrospectiveProvider(
    deps: DreamTaskExecutorDeps,
    db: Database,
    projectIdentity: string,
): RetrospectiveRawProvider | null {
    if (!deps.retrospectiveRawProvider) return null;
    return typeof deps.retrospectiveRawProvider === "function"
        ? deps.retrospectiveRawProvider(db, projectIdentity)
        : deps.retrospectiveRawProvider;
}

function withGlobalOrdinals(messages: RetrospectiveRawMessage[]): RetrospectiveRawMessage[] {
    return messages.map((message, index) => ({ ...message, ordinal: index + 1 }));
}

function renderGateUserLines(messages: RetrospectiveRawMessage[]): string[] {
    return messages
        .filter((message) => message.role === "user")
        .map((message) => `${message.ordinal}: ${message.text}`);
}

/** Retrospective extraction re-reads 12 user lines before the watermark to overlap the prior window.
 * */
const RETROSPECTIVE_OVERLAP_USER_LINES = 12;

/** The parser accepts `n`/`no` for no friction and `y:`/`yes:` with positive ordinals for flagged lines.
 * The parser extracts ordinals only after a `y:` or `yes:` marker.
 * The parser returns no hit when it finds no recognized verdict with positive ordinals.
 * */
export function parseFrictionGateVerdict(verdict: string): { hit: boolean; ordinals: number[] } {
    const ordinalsFrom = (line: string): number[] => {
        const afterColon = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
        return (afterColon.match(/\d+/g) ?? [])
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0);
    };

    for (const raw of verdict.split(/\r?\n/)) {
        const line = raw.trim().toLowerCase();
        if (!line) continue;
        if (/^n(o)?\b/.test(line)) return { hit: false, ordinals: [] };
        // A positive verdict requires `y:` or `yes:` followed by a colon.
        if (/^y(es)?\s*:/.test(line)) {
            const ordinals = ordinalsFrom(line);
            return { hit: ordinals.length > 0, ordinals };
        }
    }

    const embedded = verdict.toLowerCase().match(/\by(?:es)?\s*:\s*([\d,\s]+)/);
    if (embedded) {
        const ordinals = (embedded[1].match(/\d+/g) ?? [])
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0);
        return { hit: ordinals.length > 0, ordinals };
    }
    return { hit: false, ordinals: [] };
}

/** The source-window key hashes sorted `(sessionId:ts)` anchors for flagged user lines instead of batch-local prompt ordinals.
 * Sorting makes anchor order irrelevant; identical friction windows produce the same key across runs. */
function computeRetrospectiveWindowKey(flagged: RetrospectiveRawMessage[]): string {
    const anchors = flagged
        .map((message) => `${message.sessionId}:${message.ts}`)
        .sort()
        .join("|");
    return createHash("sha256").update(anchors).digest("hex").slice(0, 32);
}

/**
 * */
function renderFrictionWindow(
    messages: RetrospectiveRawMessage[],
    flaggedOrdinals: number[],
    radius = 2,
): string {
    const flagged = new Set(flaggedOrdinals);
    const included = new Set<number>();
    for (const anchor of flaggedOrdinals) {
        for (let ordinal = anchor - radius; ordinal <= anchor + radius; ordinal += 1) {
            included.add(ordinal);
        }
    }

    return messages
        .filter((message) => included.has(message.ordinal))
        .map((message) => {
            const role =
                message.role === "assistant" ? "A" : message.role === "tool" ? "tool" : "U";
            const suffix = flagged.has(message.ordinal) ? "  [friction]" : "";
            const tool = message.toolName ? ` ${message.toolName}` : "";
            return `${message.ordinal}. (${message.sessionId}) ${role}${tool}: ${message.text}${suffix}`;
        })
        .join("\n");
}

function retrospectiveEventsForSessions(
    db: Database,
    sessionIds: Iterable<string>,
): RetrospectivePromptEvent[] {
    const events: RetrospectivePromptEvent[] = [];
    for (const sessionId of sessionIds) {
        try {
            for (const event of getCompartmentEvents(db, sessionId)) {
                if (event.kind !== "causal_incident" && event.kind !== "trajectory_correction") {
                    log(`[dreamer] dropping event: unknown kind="${event.kind}"`);
                    continue;
                }
                events.push({
                    sessionId,
                    kind: event.kind,
                    fields: event.fields,
                    createdAt: event.createdAt,
                });
            }
        } catch {
            // Event corroboration is optional; ignore event-loading failures.
        }
    }
    return events.sort((a, b) => a.createdAt - b.createdAt).slice(-20);
}

/**
 * Route-`memory` learnings are claim-native, so telemetry must use `effects` because the legacy `memories` diff omits them.
 */
interface RetrospectiveTaskOutcome {
    retrospectiveWatermarkMs: number | null;
    effects: readonly ClaimOperationResultEffect[];
}

async function runRetrospectiveTask(
    config: DreamTaskRuntimeConfig,
    ctx: TaskExecutorContext,
    helpers: {
        deps: DreamTaskExecutorDeps;
        deadline: number;
        parent: string | undefined;
        invocationStartedAt: number;
    },
): Promise<RetrospectiveTaskOutcome> {
    const { db, projectIdentity, holderId, leaseKey } = ctx;
    const { deps, deadline, parent } = helpers;
    const provider = resolveRetrospectiveProvider(deps, db, projectIdentity);
    if (!provider) {
        log("[dreamer] retrospective: no raw provider available — clean no-op");
        return { retrospectiveWatermarkMs: null, effects: [] };
    }

    // The content watermark is the maximum timestamp of scanned messages, not `lastRunAt`.
    // The content watermark must not use `lastRunAt`: it records schedule completion and can skip messages that arrive mid-run.
    const watermarkMs =
        getTaskScheduleState(db, projectIdentity, config.task)?.retrospectiveWatermarkMs ?? 0;

    const scan = await readRetrospectiveScanWindow(
        provider,
        projectIdentity,
        watermarkMs,
        RETROSPECTIVE_OVERLAP_USER_LINES,
    );
    const messages = withGlobalOrdinals(scan.messages);
    const userMessages = messages.filter((message) => message.role === "user");
    if (userMessages.length === 0) {
        log("[dreamer] retrospective: no user messages in window");
        return { retrospectiveWatermarkMs: scan.maxScannedTs, effects: [] };
    }

    // Only post-watermark user lines are new; earlier lines are overlap.
    // The overlap is re-read. If no post-watermark line exists, the previous run already handled the window.
    const postWatermarkOrdinals = new Set(
        userMessages
            .filter((message) => message.ts > watermarkMs)
            .map((message) => message.ordinal),
    );
    if (postWatermarkOrdinals.size === 0) {
        log("[dreamer] retrospective: only overlap lines, nothing new");
        return { retrospectiveWatermarkMs: scan.maxScannedTs, effects: [] };
    }

    const abortController = new AbortController();
    let leaseLost = false;
    const heartbeat = startLeaseHeartbeat(
        db,
        holderId,
        leaseKey,
        () => {
            leaseLost = true;
            abortController.abort();
        },
        ctx.leaseAcquisition,
    );

    let childSessionId: string | null = null;
    try {
        const createResponse = await createChildSessionWithFence({
            client: deps.client,
            db,
            parentSessionId: parent ?? undefined,
            title: "magic-context-dream-retrospective",
            directory: deps.sessionDirectory,
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        childSessionId = typeof created?.id === "string" ? created.id : null;
        if (!childSessionId) throw new Error("Retrospective could not create its child session.");
        const sessionId = childSessionId;

        // OpenCode applies each prompt's `body.system`, so the first turn uses the gate system and a hit enables the deepen system.
        // Fetching the child branch's final output counts both turns' token usage exactly once.
        const runChildTurn = async (system: string, userText: string) => {
            const remainingMs = Math.max(0, deadline - Date.now());
            return shared.promptSyncWithValidatedOutputRetry(
                deps.client,
                {
                    path: { id: sessionId },
                    query: { directory: deps.sessionDirectory },
                    body: {
                        agent: DREAMER_RETROSPECTIVE_AGENT,
                        system,
                        ...modelBodyField(config.model),
                        parts: [{ type: "text", text: userText, synthetic: true }],
                    },
                },
                {
                    timeoutMs: Math.min(remainingMs, config.timeoutMinutes * 60 * 1000),
                    signal: abortController.signal,
                    fallbackModels: config.fallbackModels,
                    callContext: "dreamer:retrospective",
                    fetchOutput: childSessionMessagesFetcher(
                        deps.client,
                        sessionId,
                        deps.sessionDirectory,
                        50,
                    ),
                    validateOutput: (outputMessages) => {
                        const text = extractLatestAssistantText(outputMessages);
                        if (!text) throw new Error("Retrospective child returned no output.");
                        return text;
                    },
                },
            );
        };

        const finish = (
            run: { output: unknown[] } | null,
            watermark: number | null,
            effects: readonly ClaimOperationResultEffect[] = [],
        ): RetrospectiveTaskOutcome => {
            if (parent && run) {
                recordChildInvocation({
                    db,
                    parentSessionId: parent,
                    harness: "opencode",
                    subagent: "dreamer",
                    task: config.task,
                    startedAt: helpers.invocationStartedAt,
                    status: "completed",
                    messages: run.output,
                });
            }
            return { retrospectiveWatermarkMs: watermark, effects };
        };

        const userLines = renderGateUserLines(messages);
        const gateRun = await runChildTurn(
            FRICTION_GATE_SYSTEM_PROMPT,
            buildFrictionGatePrompt({ userLines }),
        );
        if (leaseLost) throw new Error("Dream lease lost during retrospective");
        const gate = parseFrictionGateVerdict(gateRun.validated);
        if (!gate.hit) {
            log("[dreamer] retrospective: gate — no friction");
            return finish(gateRun, scan.maxScannedTs);
        }

        const flagged = userMessages.filter((message) => gate.ordinals.includes(message.ordinal));
        // The second turn requires a flagged post-watermark line because the previous run handled friction wholly within the overlap.
        if (!flagged.some((message) => postWatermarkOrdinals.has(message.ordinal))) {
            log("[dreamer] retrospective: gate hit only on overlap lines");
            return finish(gateRun, scan.maxScannedTs);
        }

        // A stable key over flagged anchors deduplicates source windows.
        // The deduplication key uses `(sessionId:ts)` anchors rather than batch-local prompt ordinals; an existing key skips the second turn.
        // An already-deepened exact window skips the second turn.
        const windowKey = computeRetrospectiveWindowKey(flagged);
        if (isRetrospectiveWindowProcessed(db, projectIdentity, windowKey)) {
            log("[dreamer] retrospective: window already processed");
            return finish(gateRun, scan.maxScannedTs);
        }

        // The host renders the zoom window; the LLM extracts the rule.
        const frictionWindow = renderFrictionWindow(
            messages,
            flagged.map((message) => message.ordinal),
        );
        const eventSessionIds = new Set(messages.map((message) => message.sessionId));
        const events = retrospectiveEventsForSessions(db, eventSessionIds);
        const deepenRun = await runChildTurn(
            withContentLanguageDirective(
                RETROSPECTIVE_SYSTEM_PROMPT,
                config.language ?? deps.language,
                {
                    retrospective: true,
                },
            ),
            buildRetrospectivePrompt({ projectPath: projectIdentity, frictionWindow, events }),
        );
        if (leaseLost) throw new Error("Dream lease lost during retrospective");

        const sourceSessionId =
            flagged[0]?.sessionId ?? userMessages[0]?.sessionId ?? "retrospective";
        const learnings = parseRetrospectiveLearnings(deepenRun.validated);
        const identity: AutonomousManifestIdentity = {
            ...dreamerManifestIdentity({
                db,
                holderId,
                leaseKey,
                parentSessionId: parent,
                task: "retrospective",
                publicClaimIds: [],
            }),
            batchId: windowKey,
        };
        const applied = runLeaseGuardedWrite(
            db,
            holderId,
            leaseKey,
            (): ReturnType<typeof applyRetrospectiveLearnings> => {
                const result = applyRetrospectiveLearnings({
                    db,
                    projectIdentity,
                    sourceSessionId,
                    learnings,
                    identity,
                    userMemoryCollectionEnabled: deps.userMemoryCollectionEnabled === true,
                    sourceUserTexts: userMessages
                        .map((message) => message.text ?? "")
                        .filter((text) => text.length > 0),
                });
                recordRetrospectiveWindowProcessed(db, projectIdentity, windowKey);
                return result;
            },
            typeof identity.leaseGeneration === "number" ? identity.leaseGeneration : undefined,
        );
        if (leaseLost || !applied) throw new Error("Dream lease lost during retrospective commit");
        log(
            `[dreamer] retrospective: flagged=${flagged.length} learnings=${learnings.length} memory=${applied.memoryWritten} observations=${applied.observationsInserted} dropped=${applied.observationsDropped} rejected=${applied.rejected.length}`,
        );
        return finish(deepenRun, scan.maxScannedTs, applied.effects);
    } finally {
        heartbeat.stop();
        // The cleanup path deletes the child session even on failure and when `keep_subagents` is set.
        // The child-session directory must never persist another session's raw user text on disk.
        if (childSessionId) {
            await deps.client.session.delete({ path: { id: childSessionId } }).catch(() => {});
        }
    }
}

/** The curate pool loads after child-session creation so hidden or rewritten memories cannot enter the child prompt.
 * */
async function runAgenticTask(
    config: DreamTaskRuntimeConfig,
    ctx: TaskExecutorContext,
    helpers: {
        deps: DreamTaskExecutorDeps;
        deadline: number;
        parent: string | undefined;
        recordRun: (
            status: "completed" | "failed",
            error: string | null,
            extra?: {
                memoryChanges?: DreamRunMemoryChanges | null;
            },
        ) => void;
        computeMemoryDelta: (
            before: ReturnType<typeof censusProjectMemoryClaims>,
        ) => { written: number; deleted: number; archived: number; merged: number } | null;
    },
): Promise<TaskExecOutcome> {
    const { db, projectIdentity, holderId, leaseKey } = ctx;
    const { deps, deadline, parent } = helpers;
    const task = config.task as DreamingTask;
    const docsDir = deps.sessionDirectory;
    const invocationStartedAt = Date.now();

    const lastRunAt = getTaskScheduleState(db, projectIdentity, config.task)?.lastRunAt ?? null;

    const maintainDocsSnapshot =
        task === "maintain-docs" ? snapshotMaintainDocsFiles(docsDir) : undefined;
    const existingDocs =
        task === "maintain-docs"
            ? {
                  architecture: existsSync(`${docsDir}/ARCHITECTURE.md`),
                  structure: existsSync(`${docsDir}/STRUCTURE.md`),
              }
            : undefined;
    const userMemories =
        task === "curate"
            ? getActiveUserMemories(db).map((um) => ({ id: um.id, content: um.content }))
            : undefined;

    const abortController = new AbortController();
    let leaseLost = false;
    const declareLeaseLost = (): void => {
        leaseLost = true;
        abortController.abort();
    };
    const heartbeat = startLeaseHeartbeat(
        db,
        holderId,
        leaseKey,
        declareLeaseLost,
        ctx.leaseAcquisition,
    );

    let childSessionId: string | null = null;
    let rawCurateManifest = "";
    let curateIdentity: AutonomousManifestIdentity | undefined;
    let curateMemoryChanges: DreamRunMemoryChanges | null = null;
    try {
        const createResponse = await createChildSessionWithFence({
            client: deps.client,
            db,
            parentSessionId: parent ?? undefined,
            title: `magic-context-dream-${task}`,
            directory: docsDir,
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        childSessionId = typeof created?.id === "string" ? created.id : null;
        if (!childSessionId) throw new Error("Dreamer could not create its child session.");
        const sessionId = childSessionId;

        let curateClaims: ProjectMemoryClaimSnapshot[] | undefined;
        let curateMemories: CuratePromptMemory[] | undefined;
        if (task === "curate") {
            curateClaims = loadCurateClaims(db, projectIdentity);
            curateMemories = curateClaims.map(toCuratePromptMemory);
            curateIdentity = dreamerManifestIdentity({
                db,
                holderId,
                leaseKey,
                parentSessionId: parent,
                task: "curate",
                publicClaimIds: curateClaims.map((claim) => claim.publicClaimId),
            });
            log(`[dreamer] curate pool: in_scope=${curateMemories.length}`);
        }
        const taskPrompt = buildDreamTaskPrompt(task, {
            projectPath: projectIdentity,
            lastDreamAt: lastRunAt ? String(lastRunAt) : null,
            existingDocs,
            userMemories,
            curate: curateMemories ? { memories: curateMemories } : undefined,
        });

        if (task === "curate") await deps.curateLifecycle?.beforePrompt?.();
        // The code recomputes the remaining deadline after `beforePrompt` because the hook consumes deadline budget.
        // A stale remaining window can let the prompt exceed `deadline`.
        const remainingMs = Math.max(0, deadline - Date.now());
        const promptTimeoutMs = Math.min(remainingMs, config.timeoutMinutes * 60 * 1000);
        if (promptTimeoutMs <= 0) {
            throw Object.assign(
                new Error(`Dreamer ${task} deadline expired before the prompt was submitted.`),
                { transient: true },
            );
        }
        const run = await shared.promptSyncWithValidatedOutputRetry(
            deps.client,
            {
                path: { id: sessionId },
                query: { directory: docsDir },
                body: {
                    agent: task === "maintain-docs" ? DREAMER_DOCS_AGENT : DREAMER_AGENT,
                    system:
                        task === "maintain-docs"
                            ? MAINTAIN_DOCS_SYSTEM_PROMPT
                            : withContentLanguageDirective(
                                  CURATE_SYSTEM_PROMPT,
                                  config.language ?? deps.language,
                              ),
                    ...modelBodyField(config.model),
                    parts: [{ type: "text", text: taskPrompt, synthetic: true }],
                },
            },
            {
                timeoutMs: promptTimeoutMs,
                signal: abortController.signal,
                fallbackModels: config.fallbackModels,
                callContext: `dreamer:${task}`,
                fetchOutput: childSessionMessagesFetcher(deps.client, sessionId, docsDir, 50),
                validateOutput: (messages) => {
                    const text = extractLatestAssistantText(messages);
                    if (!text) throw new Error("Dreamer returned no assistant output.");
                    if (task === "curate") {
                        rawCurateManifest = text;
                        validateCurateManifest(
                            text,
                            new Set((curateClaims ?? []).map((claim) => claim.publicClaimId)),
                        );
                    }
                    return text;
                },
            },
        );
        if (task === "curate") {
            await deps.curateLifecycle?.afterPrompt?.(declareLeaseLost);
        }

        if (leaseLost) throw new Error("Dream lease lost during task");
        if (task === "curate" && curateClaims && curateIdentity) {
            const applied = runLeaseGuardedWrite(
                db,
                holderId,
                leaseKey,
                () =>
                    applyCurateManifest({
                        db,
                        projectIdentity,
                        claims: curateClaims,
                        identity: curateIdentity as AutonomousManifestIdentity,
                        manifestText: run.validated,
                    }),
                typeof curateIdentity.leaseGeneration === "number"
                    ? curateIdentity.leaseGeneration
                    : undefined,
            );
            if (applied.operation.outcome === "stale") {
                throw new Error(
                    `Curate manifest became stale: ${applied.operation.result.staleReason}`,
                );
            }
            curateMemoryChanges = claimEffectMemoryChanges(applied.operation.result.effects);
        }

        if (parent) {
            recordChildInvocation({
                db,
                parentSessionId: parent,
                harness: "opencode",
                subagent: "dreamer",
                task,
                startedAt: invocationStartedAt,
                status: "completed",
                messages: run.output,
            });
        }

        if (task === "maintain-docs" && maintainDocsSnapshot && maintainDocsSnapshot.size > 0) {
            try {
                enforceMaintainDocsProtectedRegions({ docsDir, snapshot: maintainDocsSnapshot });
            } catch (e) {
                log(`[dreamer] maintain-docs protected-region enforcement failed: ${e}`);
            }
        }

        helpers.recordRun("completed", null, { memoryChanges: curateMemoryChanges });
        return { status: "completed" };
    } catch (error) {
        if (task === "curate" && curateIdentity) {
            try {
                recordDreamerManifestRejection({
                    db,
                    holderId,
                    leaseKey,
                    identity: curateIdentity,
                    rawManifest: rawCurateManifest,
                    reason: describeError(error).brief,
                });
            } catch {}
        }
        throw error;
    } finally {
        heartbeat.stop();
        if (childSessionId) {
            await deps.client.session.delete({ path: { id: childSessionId } }).catch(() => {});
        }
    }
}
