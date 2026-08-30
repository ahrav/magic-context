import { DREAMER_MEMORY_MAPPER_AGENT } from "../../../agents/dreamer";
import { createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import {
    extractLatestAssistantText,
    hasLengthCappedOutput,
} from "../../../shared/assistant-message-extractor";
import { describeError, getErrorMessage } from "../../../shared/error-message";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { normalizeVerificationFiles } from "../memory";
import {
    type AutonomousManifestIdentity,
    runAutonomousManifestInCurrentTransaction,
} from "../memory/storage-claim-autonomous";
import type { ProjectMemoryClaimSnapshot } from "../memory/storage-claim-current-state";
import { stageApplyProjectMemoryMappingInCurrentTransaction } from "../memory/storage-claim-operations";
import { APPLICABILITY_BASELINE_STREAM_KEY } from "../storage-claim-applicability-schema";
import { recordChildInvocation } from "../subagent-token-capture";
import {
    claimManifestBinding,
    dreamerManifestIdentity,
    readDreamerProjectClaims,
    recordDreamerManifestRejection,
    sameClaimManifestBinding,
} from "./claim-manifest";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "./lease";
import {
    buildMapMemoriesPrompt,
    extractMemoryCandidatePaths,
    MAP_MEMORIES_SYSTEM_PROMPT,
    type MapMemoryInput,
    validateMapMemoriesManifest,
} from "./map-memories-prompt";
import type { DreamerModuleRoute } from "./module-apply";
import {
    DreamerProviderOutputFailureError,
    providerOutputFailureFromInvalidManifest,
} from "./provider-output-failure";

export const MAP_BATCH_SIZE = 80;
export const DREAM_MAP_MEMORIES_SESSION_TITLE = "magic-context-dream-map-memories";
export const MAX_INDEPENDENT_REQUEUE_PER_RUN = MAP_BATCH_SIZE;

export interface MapMemoriesArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    leaseAcquisition?: LeaseAcquisition;
    model?: string;
    fallbackModels?: readonly string[];
    moduleRoute?: DreamerModuleRoute;
    onProgress?: (processed: number) => void;
}

export interface MapMemoriesResult {
    mapped: number;
    independent: number;
    batches: number;
    remaining: number;
    complete: boolean;
}

export function shouldRequeueIndependentMapping(
    state: { hasSentinel: boolean; files: readonly string[] },
    content: string,
    repoDir: string,
): boolean {
    return (
        state.hasSentinel &&
        state.files.length === 0 &&
        extractMemoryCandidatePaths(content, repoDir).length > 0
    );
}

function baselineApplicability(claim: ProjectMemoryClaimSnapshot) {
    return claim.applicability.find(
        (assertion) => assertion.streamKey === APPLICABILITY_BASELINE_STREAM_KEY,
    );
}

function toMapInput(claim: ProjectMemoryClaimSnapshot, repoDir: string): MapMemoryInput {
    return {
        publicClaimId: claim.publicClaimId,
        revisionLocator: claim.revisionLocator,
        contentDigest: claim.contentDigest,
        mutationToken: claim.mutationToken,
        category: claim.category,
        content: claim.content,
        candidates: extractMemoryCandidatePaths(claim.content, repoDir),
    };
}

export function selectMapMemoryInputs(
    db: Database,
    projectIdentity: string,
    repoDir: string,
): MapMemoryInput[] {
    const active = readDreamerProjectClaims(db, projectIdentity, "verification");
    const unmapped: MapMemoryInput[] = [];
    const requeue: MapMemoryInput[] = [];
    for (const claim of active) {
        const baseline = baselineApplicability(claim);
        if (!baseline || baseline.pathsState === "unknown") {
            unmapped.push(toMapInput(claim, repoDir));
            continue;
        }
        if (
            requeue.length < MAX_INDEPENDENT_REQUEUE_PER_RUN &&
            shouldRequeueIndependentMapping(
                {
                    hasSentinel: baseline.pathsState === "known" && baseline.paths.length === 0,
                    files: baseline.paths.map((path) => path.value),
                },
                claim.content,
                repoDir,
            )
        ) {
            requeue.push(toMapInput(claim, repoDir));
        }
    }
    return [...unmapped, ...requeue];
}

export async function mapMemories(args: MapMemoriesArgs): Promise<MapMemoriesResult> {
    const result: MapMemoriesResult = {
        mapped: 0,
        independent: 0,
        batches: 0,
        remaining: 0,
        complete: true,
    };
    const inputs = selectMapMemoryInputs(args.db, args.projectIdentity, args.sessionDirectory);
    if (inputs.length === 0) return result;
    const batches: MapMemoryInput[][] = [];
    for (let index = 0; index < inputs.length; index += MAP_BATCH_SIZE) {
        batches.push(inputs.slice(index, index + MAP_BATCH_SIZE));
    }
    result.remaining = inputs.length;

    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(
        args.db,
        args.holderId,
        args.leaseKey,
        () => abortController.abort(),
        args.leaseAcquisition,
    );
    try {
        for (let index = 0; index < batches.length; index += 1) {
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) break;
            const counts = await mapOneBatch(
                args,
                batches[index] ?? [],
                Math.max(1, Math.floor(remainingMs / (batches.length - index))),
                abortController.signal,
            );
            result.mapped += counts.mapped;
            result.independent += counts.independent;
            result.remaining -= counts.mapped + counts.independent;
            result.batches += 1;
            args.onProgress?.(result.mapped + result.independent);
        }
        result.complete = result.remaining === 0;
        log(
            `[dreamer] map-memories: mapped=${result.mapped} independent=${result.independent} batches=${result.batches} remaining=${result.remaining} complete=${result.complete}`,
        );
        return result;
    } finally {
        heartbeat.stop();
    }
}

async function mapOneBatch(
    args: MapMemoriesArgs,
    selectedBatch: MapMemoryInput[],
    sliceMs: number,
    signal: AbortSignal,
): Promise<{ mapped: number; independent: number }> {
    let agentSessionId: string | null = null;
    let rawManifest = "";
    let identity: AutonomousManifestIdentity = dreamerManifestIdentity({
        ...args,
        task: "map-memories",
        publicClaimIds: selectedBatch.map((input) => input.publicClaimId),
    });
    const startedAt = Date.now();
    try {
        const createResponse = await createChildSessionWithFence({
            client: args.client,
            db: args.db,
            parentSessionId: args.parentSessionId,
            title: DREAM_MAP_MEMORIES_SESSION_TITLE,
            directory: args.sessionDirectory,
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) throw new Error("Could not create map-memories session.");

        const refreshedById = new Map(
            readDreamerProjectClaims(args.db, args.projectIdentity, "verification").map((claim) => [
                claim.publicClaimId,
                claim,
            ]),
        );
        const batch = selectedBatch.flatMap((input) => {
            const claim = refreshedById.get(input.publicClaimId);
            if (!claim) return [];
            const inputBinding = {
                publicClaimId: input.publicClaimId,
                revisionLocator: input.revisionLocator,
                contentDigest: input.contentDigest,
                token: input.mutationToken,
            };
            return sameClaimManifestBinding(inputBinding, claimManifestBinding(claim))
                ? [toMapInput(claim, args.sessionDirectory)]
                : [];
        });
        if (batch.length === 0) return { mapped: 0, independent: 0 };
        identity = dreamerManifestIdentity({
            ...args,
            task: "map-memories",
            publicClaimIds: batch.map((input) => input.publicClaimId),
        });
        const prompt = buildMapMemoriesPrompt(args.projectIdentity, batch);
        const run = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_MEMORY_MAPPER_AGENT,
                    system: MAP_MEMORIES_SYSTEM_PROMPT,
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                timeoutMs: sliceMs,
                signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:map-memories",
                fetchOutput: async () => {
                    const messagesResponse = await args.client.session.messages({
                        path: { id: agentSessionId as string },
                        query: { directory: args.sessionDirectory, limit: 100 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => {
                    if (hasLengthCappedOutput(messages)) {
                        throw new Error("map-memories returned length-capped output");
                    }
                    const text = extractLatestAssistantText(messages);
                    if (!text) throw new Error("map-memories returned no output");
                    rawManifest = text;
                    try {
                        validateMapMemoriesManifest(
                            text,
                            new Set(batch.map((input) => input.publicClaimId)),
                        );
                    } catch (error) {
                        const providerFailure = providerOutputFailureFromInvalidManifest(
                            messages,
                            text,
                        );
                        if (providerFailure) throw providerFailure;
                        throw error;
                    }
                    return text;
                },
            },
        );
        recordInvocation(args, startedAt, { status: "completed", messages: run.output });
        return await applyBatchMappings(args, batch, run.validated);
    } catch (error) {
        try {
            recordDreamerManifestRejection({
                ...args,
                identity,
                rawManifest,
                reason: getErrorMessage(error),
            });
        } catch (recordError) {
            log(`[dreamer] map-memories rejection receipt failed: ${getErrorMessage(recordError)}`);
        }
        const desc = describeError(error);
        log(
            `[dreamer] map-memories batch failed: ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        recordInvocation(args, startedAt, { status: "failed", error });
        if (signal.aborted || error instanceof DreamerProviderOutputFailureError) throw error;
        return { mapped: 0, independent: 0 };
    } finally {
        if (agentSessionId && !shouldKeepSubagents()) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((error: unknown) => {
                    log(`[dreamer] map-memories session cleanup failed: ${getErrorMessage(error)}`);
                });
        }
    }
}

export async function applyBatchMappings(
    args: MapMemoriesArgs,
    batch: MapMemoryInput[],
    manifestText: string,
): Promise<{ mapped: number; independent: number }> {
    const identity = dreamerManifestIdentity({
        ...args,
        task: "map-memories",
        publicClaimIds: batch.map((input) => input.publicClaimId),
    });
    let parsed: ReturnType<typeof validateMapMemoriesManifest>;
    try {
        parsed = validateMapMemoriesManifest(
            manifestText,
            new Set(batch.map((input) => input.publicClaimId)),
        );
    } catch (error) {
        recordDreamerManifestRejection({
            ...args,
            identity,
            rawManifest: manifestText,
            reason: getErrorMessage(error),
        });
        throw error;
    }
    const byId = new Map(batch.map((input) => [input.publicClaimId, input]));
    const planned: Array<{
        publicClaimId: string;
        files: string[];
        independent: boolean;
    }> = [];
    for (const entry of parsed) {
        if (entry.independent) {
            planned.push({ publicClaimId: entry.publicClaimId, files: [], independent: true });
            continue;
        }
        const normalized = await normalizeVerificationFiles({
            cwd: args.sessionDirectory,
            files: entry.files,
        });
        if (normalized.files.length === 0) {
            const error = new Error(`mapping entry ${entry.publicClaimId} has no valid files`);
            recordDreamerManifestRejection({
                ...args,
                identity,
                rawManifest: manifestText,
                reason: error.message,
            });
            throw error;
        }
        planned.push({
            publicClaimId: entry.publicClaimId,
            files: normalized.files,
            independent: false,
        });
    }

    const applied = runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () =>
        runAutonomousManifestInCurrentTransaction({
            db: args.db,
            identity,
            items: planned.map((item) => {
                const input = byId.get(item.publicClaimId);
                if (!input) throw new Error(`mapping returned unknown claim ${item.publicClaimId}`);
                return {
                    binding: {
                        publicClaimId: input.publicClaimId,
                        revisionLocator: input.revisionLocator,
                        contentDigest: input.contentDigest,
                        token: input.mutationToken,
                    },
                    value: item,
                };
            }),
            manifest: planned.map((item) => ({
                files: item.files,
                independent: item.independent,
                publicClaimId: item.publicClaimId,
            })),
            resultSummary: {
                independent: planned.filter((item) => item.independent).length,
                mapped: planned.filter((item) => !item.independent).length,
            },
            stageItem: (db, item, nowMs) =>
                stageApplyProjectMemoryMappingInCurrentTransaction(
                    db,
                    {
                        token: item.binding.token,
                        revisionLocator: item.binding.revisionLocator,
                        paths: {
                            state: "known",
                            exact: item.value.files,
                        },
                    },
                    nowMs,
                ),
        }),
    );
    if (applied.operation.outcome !== "applied") return { mapped: 0, independent: 0 };
    const summary = applied.summary as { mapped?: unknown; independent?: unknown } | null;
    return {
        mapped: typeof summary?.mapped === "number" ? summary.mapped : 0,
        independent: typeof summary?.independent === "number" ? summary.independent : 0,
    };
}

function recordInvocation(
    args: MapMemoriesArgs,
    startedAt: number,
    params: { status: "completed" | "failed"; messages?: unknown[]; error?: unknown },
): void {
    if (!args.parentSessionId) return;
    recordChildInvocation({
        db: args.db,
        parentSessionId: args.parentSessionId,
        harness: "opencode",
        subagent: "dreamer",
        task: "map-memories",
        startedAt,
        status: params.status,
        messages: params.messages,
        error: params.error,
    });
}
