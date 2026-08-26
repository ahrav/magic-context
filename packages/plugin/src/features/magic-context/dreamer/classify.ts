import { DREAMER_CLASSIFIER_AGENT } from "../../../agents/dreamer";
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
import { hasShareabilitySensitiveText } from "../../../shared/redaction";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import {
    type AutonomousManifestIdentity,
    runAutonomousManifestInCurrentTransaction,
} from "../memory/storage-claim-autonomous";
import type { ProjectMemoryClaimSnapshot } from "../memory/storage-claim-current-state";
import { stageReviseProjectMemoryClaimInCurrentTransaction } from "../memory/storage-claim-operations";
import { sha256Utf8Hex } from "../memory/storage-claims";
import { recordChildInvocation } from "../subagent-token-capture";
import {
    claimManifestBinding,
    dreamerInferenceProvenance,
    dreamerManifestIdentity,
    readDreamerProjectClaims,
    recordDreamerManifestRejection,
    refreshDreamerClaimBatch,
} from "./claim-manifest";
import {
    buildClassifyPrompt,
    CLASSIFY_SYSTEM_PROMPT,
    type ClassifyAnchorMemory,
    type ClassifyPromptMemory,
    validateClassifyManifest,
} from "./classify-prompt";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "./lease";
import { DreamerModuleFailureError } from "./module-apply";
import {
    DreamerProviderOutputFailureError,
    providerOutputFailureFromInvalidManifest,
} from "./provider-output-failure";

const MIN_POOL_TO_CLASSIFY = 10;
const FULL_POOL_CEILING = 100;
const STAGE3_ANCHOR_COUNT = 30;
const CLASSIFY_CHUNK_SIZE = 100;
const CLASSIFY_MODULE_RUN_TIMEOUT_MS = 660_000;

export interface ClassifyModuleCallArgs {
    sessionId: string;
    projectRoot: string;
    method: string;
    body: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface ClassifyModuleClient {
    call(args: ClassifyModuleCallArgs): Promise<unknown>;
}

export interface ClassifyArgs {
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
    modelChain?: readonly string[];
    moduleClient?: ClassifyModuleClient;
    moduleSessionId?: string;
    moduleProjectRoot?: string;
    moduleContextStoreUuid?: string;
    moduleAuthorityGeneration?: number;
    moduleCommandId?: string;
    onProgress?: (processed: number) => void;
}

export interface ClassifyResult {
    classified: number;
    changed: number;
    chunks: number;
    stage: 1 | 2 | 3;
    remaining: number;
    complete: boolean;
}

function isModuleRoute(args: ClassifyArgs): boolean {
    return (
        args.moduleClient !== undefined &&
        args.moduleSessionId !== undefined &&
        args.moduleProjectRoot !== undefined &&
        args.moduleContextStoreUuid !== undefined &&
        args.moduleAuthorityGeneration !== undefined
    );
}

function toPromptMemory(claim: ProjectMemoryClaimSnapshot): ClassifyPromptMemory {
    return {
        publicClaimId: claim.publicClaimId,
        revisionLocator: claim.revisionLocator,
        contentDigest: claim.contentDigest,
        category: claim.category,
        content: claim.content,
        importance: claim.importance,
        scope: claim.memoryScope,
        shareable: claim.sharing === "shareable",
    };
}

function toAnchor(claim: ProjectMemoryClaimSnapshot): ClassifyAnchorMemory {
    return {
        publicClaimId: claim.publicClaimId,
        category: claim.category,
        content: claim.content,
        importance: claim.importance,
    };
}

function isClassified(claim: ProjectMemoryClaimSnapshot): boolean {
    return claim.evidence.independenceKeys.some((key) => key.startsWith("classify-memories:"));
}

function stratifiedAnchors(
    classified: ProjectMemoryClaimSnapshot[],
    count: number,
): ProjectMemoryClaimSnapshot[] {
    if (classified.length <= count) return classified;
    const sorted = [...classified].sort((left, right) => left.importance - right.importance);
    const step = sorted.length / count;
    return Array.from({ length: count }, (_, index) => {
        const claim = sorted[Math.min(sorted.length - 1, Math.floor(index * step))];
        if (!claim) throw new Error("classify anchor selection failed");
        return claim;
    });
}

export async function runClassify(args: ClassifyArgs): Promise<ClassifyResult> {
    const active = readDreamerProjectClaims(args.db, args.projectIdentity, "hygiene");
    if (active.length < MIN_POOL_TO_CLASSIFY) {
        return {
            classified: 0,
            changed: 0,
            chunks: 0,
            stage: 1,
            remaining: 0,
            complete: true,
        };
    }

    const stage = active.length <= FULL_POOL_CEILING ? 2 : 3;
    const toClassify = stage === 2 ? active : active.filter((claim) => !isClassified(claim));
    const anchors =
        stage === 2
            ? []
            : stratifiedAnchors(
                  active.filter((claim) => isClassified(claim)),
                  STAGE3_ANCHOR_COUNT,
              );
    const result: ClassifyResult = {
        classified: 0,
        changed: 0,
        chunks: 0,
        stage,
        remaining: toClassify.length,
        complete: toClassify.length === 0,
    };
    if (toClassify.length === 0) return result;

    const chunks: ProjectMemoryClaimSnapshot[][] = [];
    for (let index = 0; index < toClassify.length; index += CLASSIFY_CHUNK_SIZE) {
        chunks.push(toClassify.slice(index, index + CLASSIFY_CHUNK_SIZE));
    }

    const abortController = new AbortController();
    const heartbeat = startLeaseHeartbeat(
        args.db,
        args.holderId,
        args.leaseKey,
        () => abortController.abort(),
        args.leaseAcquisition,
    );
    try {
        for (let index = 0; index < chunks.length; index += 1) {
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) break;
            const counts = await classifyOneChunk(
                args,
                chunks[index] ?? [],
                anchors,
                Math.max(1, Math.floor(remainingMs / (chunks.length - index))),
                abortController.signal,
            );
            result.classified += counts.classified;
            result.changed += counts.changed;
            result.remaining -= counts.classified;
            result.chunks += 1;
            args.onProgress?.(result.classified);
        }
        result.complete = result.remaining === 0;
        log(
            `[dreamer] classify: stage=${stage} classified=${result.classified} changed=${result.changed} chunks=${result.chunks} remaining=${result.remaining} complete=${result.complete}`,
        );
        return result;
    } finally {
        heartbeat.stop();
    }
}

async function classifyOneChunk(
    args: ClassifyArgs,
    selectedChunk: ProjectMemoryClaimSnapshot[],
    selectedAnchors: ProjectMemoryClaimSnapshot[],
    sliceMs: number,
    signal: AbortSignal,
): Promise<{ classified: number; changed: number }> {
    let agentSessionId: string | null = null;
    let rawManifest = "";
    let identity: AutonomousManifestIdentity = dreamerManifestIdentity({
        ...args,
        task: "classify-memories",
        publicClaimIds: selectedChunk.map((claim) => claim.publicClaimId),
    });
    const startedAt = Date.now();
    const moduleRoute = isModuleRoute(args);
    try {
        if (!moduleRoute) {
            const createResponse = await createChildSessionWithFence({
                client: args.client,
                db: args.db,
                parentSessionId: args.parentSessionId,
                title: "magic-context-dream-classify",
                directory: args.sessionDirectory,
            });
            const created = shared.normalizeSDKResponse(
                createResponse,
                null as { id?: string } | null,
                { preferResponseOnMissingData: true },
            );
            agentSessionId = typeof created?.id === "string" ? created.id : null;
            if (!agentSessionId) throw new Error("Could not create classify session.");
        }

        const refreshed = refreshDreamerClaimBatch({
            db: args.db,
            projectIdentity: args.projectIdentity,
            lane: "hygiene",
            claims: [...selectedChunk, ...selectedAnchors],
        });
        const refreshedById = new Map(refreshed.map((claim) => [claim.publicClaimId, claim]));
        const chunk = selectedChunk.flatMap((claim) => {
            const current = refreshedById.get(claim.publicClaimId);
            return current ? [current] : [];
        });
        const anchors = selectedAnchors.flatMap((claim) => {
            const current = refreshedById.get(claim.publicClaimId);
            return current ? [toAnchor(current)] : [];
        });
        if (chunk.length === 0) return { classified: 0, changed: 0 };
        identity = dreamerManifestIdentity({
            ...args,
            task: "classify-memories",
            publicClaimIds: chunk.map((claim) => claim.publicClaimId),
        });
        const prompt = buildClassifyPrompt({
            projectPath: args.projectIdentity,
            memories: chunk.map(toPromptMemory),
            anchors,
        });
        if (moduleRoute) {
            rawManifest = await runClassifyThroughModule(args, chunk, prompt, sliceMs, signal);
            recordInvocation(args, startedAt, { status: "completed" });
            return applyClassifications(args, chunk, rawManifest);
        }

        const run = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: agentSessionId as string },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_CLASSIFIER_AGENT,
                    system: CLASSIFY_SYSTEM_PROMPT,
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                timeoutMs: sliceMs,
                signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:classify-memories",
                fetchOutput: async () => {
                    const messagesResponse = await args.client.session.messages({
                        path: { id: agentSessionId as string },
                        query: { directory: args.sessionDirectory, limit: 50 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => {
                    if (hasLengthCappedOutput(messages)) {
                        throw new Error("classify returned length-capped output");
                    }
                    const text = extractLatestAssistantText(messages);
                    if (!text) throw new Error("classify returned no output");
                    rawManifest = text;
                    try {
                        validateClassifyManifest(
                            text,
                            new Set(chunk.map((claim) => claim.publicClaimId)),
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
        return applyClassifications(args, chunk, run.validated);
    } catch (error) {
        const failure = moduleRoute
            ? new DreamerModuleFailureError("classify module", error)
            : error;
        try {
            recordDreamerManifestRejection({
                ...args,
                identity,
                rawManifest,
                reason: getErrorMessage(failure),
            });
        } catch (recordError) {
            log(`[dreamer] classify rejection receipt failed: ${getErrorMessage(recordError)}`);
        }
        const desc = describeError(failure);
        log(
            `[dreamer] classify chunk failed: ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        recordInvocation(args, startedAt, { status: "failed", error: failure });
        if (moduleRoute || signal.aborted || failure instanceof DreamerProviderOutputFailureError) {
            throw failure;
        }
        return { classified: 0, changed: 0 };
    } finally {
        if (agentSessionId && !shouldKeepSubagents()) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((error: unknown) => {
                    log(`[dreamer] classify session cleanup failed: ${getErrorMessage(error)}`);
                });
        }
    }
}

async function runClassifyThroughModule(
    args: ClassifyArgs,
    chunk: ProjectMemoryClaimSnapshot[],
    prompt: string,
    sliceMs: number,
    signal: AbortSignal,
): Promise<string> {
    const membership = chunk.map((claim) => claim.publicClaimId).join(",");
    const response = await args.moduleClient?.call({
        sessionId: args.moduleSessionId as string,
        projectRoot: args.moduleProjectRoot as string,
        method: "dreamer.run_task",
        body: {
            method: "dreamer.run_task",
            v: 1,
            session_id: args.moduleSessionId,
            task: "classify",
            command_id: `classify:${args.moduleCommandId ?? Date.now()}:${sha256Utf8Hex(membership).slice(0, 24)}`,
            authority_generation: args.moduleAuthorityGeneration,
            payload: {
                prompt_body: prompt,
                model_chain: args.modelChain ?? [
                    ...(args.model ? [args.model] : []),
                    ...(args.fallbackModels ?? []),
                ],
                timeout_ms: Math.max(1, sliceMs - 40_000),
                items: chunk.map((claim) => ({
                    public_claim_id: claim.publicClaimId,
                    revision_locator: claim.revisionLocator,
                    content_digest: claim.contentDigest,
                    mutation_token: claim.mutationToken,
                })),
            },
        },
        signal,
        timeoutMs: Math.min(sliceMs, CLASSIFY_MODULE_RUN_TIMEOUT_MS),
    });
    const result = (response as { result?: unknown } | null)?.result ?? response;
    if (!result || typeof result !== "object") {
        throw new Error("module returned invalid classify result");
    }
    const manifestText = (result as { manifest_text?: unknown }).manifest_text;
    if (typeof manifestText !== "string") throw new Error("module returned no classify manifest");
    if ((result as { truncated?: unknown }).truncated === true) {
        throw new Error("classify returned length-capped output");
    }
    validateClassifyManifest(manifestText, new Set(chunk.map((claim) => claim.publicClaimId)));
    return manifestText;
}

export function applyClassifications(
    args: ClassifyArgs,
    chunk: ProjectMemoryClaimSnapshot[],
    manifestText: string,
): { classified: number; changed: number } {
    const identity = dreamerManifestIdentity({
        ...args,
        task: "classify-memories",
        publicClaimIds: chunk.map((claim) => claim.publicClaimId),
    });
    let parsed: ReturnType<typeof validateClassifyManifest>;
    try {
        parsed = validateClassifyManifest(
            manifestText,
            new Set(chunk.map((claim) => claim.publicClaimId)),
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
    const byId = new Map(chunk.map((claim) => [claim.publicClaimId, claim]));
    const changed = parsed.filter((entry) => {
        const claim = byId.get(entry.publicClaimId);
        return (
            claim !== undefined &&
            ((entry.importance !== undefined && entry.importance !== claim.importance) ||
                (entry.scope !== undefined && entry.scope !== claim.memoryScope) ||
                (entry.shareable !== undefined &&
                    entry.shareable !== (claim.sharing === "shareable")))
        );
    }).length;
    const applied = runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () =>
        runAutonomousManifestInCurrentTransaction({
            db: args.db,
            identity,
            items: parsed.map((entry) => {
                const claim = byId.get(entry.publicClaimId);
                if (!claim)
                    throw new Error(`classify returned unknown claim ${entry.publicClaimId}`);
                return { binding: claimManifestBinding(claim), value: entry };
            }),
            manifest: parsed.map((entry) => ({
                importance: entry.importance ?? null,
                publicClaimId: entry.publicClaimId,
                scope: entry.scope ?? null,
                shareable: entry.shareable ?? null,
            })),
            resultSummary: { changed },
            stageItem: (db, item, nowMs) => {
                const claim = byId.get(item.binding.publicClaimId);
                if (!claim) throw new Error(`missing classify claim ${item.binding.publicClaimId}`);
                const shareable =
                    item.value.shareable === true && hasShareabilitySensitiveText(claim.content)
                        ? false
                        : item.value.shareable;
                return stageReviseProjectMemoryClaimInCurrentTransaction(
                    db,
                    {
                        token: item.binding.token,
                        importance: item.value.importance,
                        memoryScope: item.value.scope,
                        sharing:
                            shareable === undefined
                                ? undefined
                                : shareable
                                  ? "shareable"
                                  : "private",
                        provenance: dreamerInferenceProvenance({
                            identity,
                            binding: item.binding,
                            sourceContent: claim.content,
                        }),
                        actor: `dreamer:${identity.runId}`,
                    },
                    nowMs,
                );
            },
        }),
    );
    if (applied.operation.outcome !== "applied") return { classified: 0, changed: 0 };
    const summary = applied.summary as { changed?: unknown } | null;
    return {
        classified: applied.appliedItems,
        changed: typeof summary?.changed === "number" ? summary.changed : 0,
    };
}

function recordInvocation(
    args: ClassifyArgs,
    startedAt: number,
    params: { status: "completed" | "failed"; messages?: unknown[]; error?: unknown },
): void {
    if (!args.parentSessionId) return;
    recordChildInvocation({
        db: args.db,
        parentSessionId: args.parentSessionId,
        harness: "opencode",
        subagent: "dreamer",
        task: "classify-memories",
        startedAt,
        status: params.status,
        messages: params.messages,
        error: params.error,
    });
}
