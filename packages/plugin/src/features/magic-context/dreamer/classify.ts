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

/**
 * `MAX_CLASSIFY_PROMPT_BYTES` mirrors `MAX_CLASSIFY_PROMPT_BYTES` in `crates/mc-module/src/classify.rs`.
 * `dreamer.run_task` refuses a longer `prompt_body` with `payload_too_large`
 * Rejected prompts are rebuilt identically on every scheduled pass.
 * Chunk construction bounds each chunk by rendered bytes and entry count.
 * A 100-entry limit allows content-heavy claims to exceed the cap.
 * Claims whose prompts exceed the cap never classify.
 */
export const MAX_CLASSIFY_PROMPT_BYTES = 256 * 1024;
/** Anchors calibrate classification rather than supply work, so the code assigns them a smaller prompt budget.
 * Each chunk includes all anchors, so anchors use a shared 48 KiB budget. */
const ANCHOR_PROMPT_BYTE_BUDGET = 48 * 1024;
/** The chunk budget reserves 16 KiB for task-template and guidance text.
 * Task-template and guidance text wrap the anchor and claim sections. */
const CHUNK_PROMPT_BYTE_BUDGET = MAX_CLASSIFY_PROMPT_BYTES - ANCHOR_PROMPT_BYTE_BUDGET - 16 * 1024;
/**
 * The fixed literals use 66 bytes.
 * Importance, scope name, and shareable consume at most 17 bytes.
 * The 128-byte reserve prevents chunks from exceeding the cap.
 */
const PROMPT_ENTRY_TEMPLATE_BYTES = 128;

/**
 * */
function promptEntryBytes(claim: ProjectMemoryClaimSnapshot): number {
    return (
        Buffer.byteLength(claim.content, "utf8") +
        Buffer.byteLength(claim.publicClaimId, "utf8") +
        Buffer.byteLength(claim.category, "utf8") +
        Buffer.byteLength(claim.revisionLocator, "utf8") +
        Buffer.byteLength(claim.contentDigest, "utf8") +
        PROMPT_ENTRY_TEMPLATE_BYTES
    );
}

/**
 * The purge margin reserves 40 seconds for cleanup after the module timeout.
 * `crates/mc-module/src/classify.rs`.
 *
 * The module's producer window ends at `timeout_ms`.
 * Cleanup continues after the producer window closes.
 * `purge_session` can consume the producer's 30-second request timeout.
 * Host reaping adds a 5-second SIGTERM-to-SIGKILL grace period.
 * Ledger writes and response dispatch require additional timeout slack.
 * Equal transport and module budgets let transport time out before cleanup.
 * Transport cancellation can occur between the producer run and session purge.
 * Cancellation between the producer run and purge records no result and prevents fallback completion.
 */
const CLASSIFY_MODULE_PURGE_MARGIN_MS = 40_000;
/**
 * The 40s purge margin plus a 120s model allowance sets the 160s minimum slice.
 * Equal division can place every chunk below the minimum slice.
 * The minimum slice processes head chunks before deferring tail chunks.
 * The minimum slice defers tail chunks to the next pass.
 * Without the minimum slice, later chunks receive progressively larger slices.
 * Stable ordering would skip head chunks on every pass.
 */
const CLASSIFY_MIN_CHUNK_SLICE_MS = CLASSIFY_MODULE_PURGE_MARGIN_MS + 120_000;

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
    /** `modelChain` orders the task override, dreamer default, and fallbacks.
     * The module route sends `modelChain` verbatim; the TypeScript path uses `model` and `fallbackModels`.
     * The dreamer default reaches classify only through `modelChain`.
     * Removing the dreamer default from `modelChain` removes that fallback. */
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

/**
 *
 * Module-backed classify cannot inherit the session model.
 * `dreamer.run_task` requires an explicit canonical `provider/model` chain.
 * The module route has no canonical string for the session default.
 * An empty `modelChain` is a permanent configuration failure.
 * An empty `modelChain` advances the task to its next cron slot instead of retrying immediately.
 */
function moduleClassifyModelChain(args: ClassifyArgs): readonly string[] {
    const modelChain = args.modelChain ?? [];
    if (modelChain.length === 0) {
        throw new Error(
            "classify has no effective model chain: set dreamer.model, " +
                "dreamer.tasks.classify-memories.model, or dreamer.fallback_models " +
                "(all are unset or malformed, and module-backed classify has no session default to fall back on)",
        );
    }
    return modelChain;
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

/**
 * classify.
 */
function chunkByCountAndBytes(
    toClassify: readonly ProjectMemoryClaimSnapshot[],
    byteBudget: number,
): { chunks: ProjectMemoryClaimSnapshot[][]; oversized: ProjectMemoryClaimSnapshot[] } {
    const chunks: ProjectMemoryClaimSnapshot[][] = [];
    const oversized: ProjectMemoryClaimSnapshot[] = [];
    let current: ProjectMemoryClaimSnapshot[] = [];
    let currentBytes = 0;
    for (const claim of toClassify) {
        const cost = promptEntryBytes(claim);
        if (cost > byteBudget) {
            oversized.push(claim);
            continue;
        }
        if (current.length >= CLASSIFY_CHUNK_SIZE || currentBytes + cost > byteBudget) {
            if (current.length > 0) chunks.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(claim);
        currentBytes += cost;
    }
    if (current.length > 0) chunks.push(current);
    return { chunks, oversized };
}

/**
 */
function boundAnchorsByBytes(
    anchors: readonly ProjectMemoryClaimSnapshot[],
    byteBudget: number,
): ProjectMemoryClaimSnapshot[] {
    const kept: ProjectMemoryClaimSnapshot[] = [];
    let bytes = 0;
    for (const anchor of anchors) {
        const cost = promptEntryBytes(anchor);
        if (bytes + cost > byteBudget) continue;
        kept.push(anchor);
        bytes += cost;
    }
    if (kept.length < anchors.length) {
        log(
            `[dreamer] classify: ${anchors.length - kept.length} anchor(s) dropped to fit the prompt byte budget`,
        );
    }
    return kept;
}

/**
 *
 * Truncating a claim would score bytes absent from the claim while the manifest binds the full revision digest.
 * A receipt for truncated content would assert a classification that nobody performed.
 * Sending an oversized claim alone triggers a `payload_too_large` module call on every scheduled pass.
 * A chunking failure is transient and retries the entire task immediately.
 *
 * Skipping oversized claims lets the remaining pool make progress.
 * The rejection receipt records the byte overflow and cap so an operator can find and shorten the claim.
 * Shortening the claim below the byte cap lets a later pass classify it.
 */
function recordOversizedClaims(
    args: ClassifyArgs,
    oversized: readonly ProjectMemoryClaimSnapshot[],
): void {
    for (const claim of oversized) {
        const bytes = promptEntryBytes(claim);
        const reason =
            `classify skipped ${claim.publicClaimId}: its rendered prompt entry is ` +
            `${bytes} bytes, over the ${CHUNK_PROMPT_BYTE_BUDGET}-byte pool budget ` +
            `(module prompt cap ${MAX_CLASSIFY_PROMPT_BYTES}); shorten the memory to classify it`;
        try {
            recordDreamerManifestRejection({
                ...args,
                identity: dreamerManifestIdentity({
                    ...args,
                    task: "classify-memories",
                    publicClaimIds: [claim.publicClaimId],
                }),
                rawManifest: "",
                reason,
            });
        } catch (error) {
            log(`[dreamer] classify oversized receipt failed: ${getErrorMessage(error)}`);
        }
        log(`[dreamer] ${reason}`);
    }
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
    const moduleRoute = isModuleRoute(args);
    const anchors = boundAnchorsByBytes(
        stage === 2
            ? []
            : stratifiedAnchors(
                  active.filter((claim) => isClassified(claim)),
                  STAGE3_ANCHOR_COUNT,
              ),
        moduleRoute ? ANCHOR_PROMPT_BYTE_BUDGET : Number.POSITIVE_INFINITY,
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

    // Calling `moduleClassifyModelChain` before the per-chunk `try` preserves configuration errors as permanent failures.
    // Errors thrown inside the per-chunk `try` become `DreamerModuleFailureError` failures.
    // `DreamerModuleFailureError` sets `transient=true`, which would retry a configuration error indefinitely.
    if (moduleRoute) moduleClassifyModelChain(args);

    const { chunks, oversized } = chunkByCountAndBytes(
        toClassify,
        moduleRoute ? CHUNK_PROMPT_BYTE_BUDGET : Number.POSITIVE_INFINITY,
    );
    if (oversized.length > 0) {
        recordOversizedClaims(args, oversized);
        // Excluding claims that cannot fit prevents `remaining` from keeping every pass incomplete and retrying forever.
        result.remaining -= oversized.length;
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
            // The floor prevents equal division from assigning every chunk insufficient time to complete.
            // Later chunks defer to the next pass when the floored allocation cannot cover the backlog.
            // Deferring later chunks prevents leading chunks from starving on every pass.
            const sliceMs = Math.min(
                remainingMs,
                Math.max(
                    Math.floor(remainingMs / (chunks.length - index)),
                    CLASSIFY_MIN_CHUNK_SLICE_MS,
                ),
            );
            const counts = await classifyOneChunk(
                args,
                chunks[index] ?? [],
                anchors,
                sliceMs,
                abortController.signal,
            );
            if (counts === null) {
                // Failure to reserve the cleanup margin leaves no workable deadline for later chunks.
                // Ending the pass avoids attempting later chunks with the same exhausted deadline.
                // The next pass starts with the same unclassified chunks.
                log(
                    `[dreamer] classify: pass ended before chunk ${index + 1}/${chunks.length}; deadline cannot host another module call`,
                );
                break;
            }
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

/**
 * `null` means the module slice cannot reserve the cleanup margin.
 * If the module cannot reserve the cleanup margin, the chunk remains unbanked.
 * The caller ends the pass rather than classifying later chunks out of order.
 */
async function classifyOneChunk(
    args: ClassifyArgs,
    selectedChunk: ProjectMemoryClaimSnapshot[],
    selectedAnchors: ProjectMemoryClaimSnapshot[],
    sliceMs: number,
    signal: AbortSignal,
): Promise<{ classified: number; changed: number } | null> {
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
            const run = await runClassifyThroughModule(
                args,
                chunk,
                prompt,
                startedAt + sliceMs,
                signal,
            );
            if (run === null) return null;
            rawManifest = run;
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
    sliceDeadline: number,
    signal: AbortSignal,
): Promise<string | null> {
    const membership = chunk.map((claim) => claim.publicClaimId).join(",");
    const modelChain = moduleClassifyModelChain(args);
    // The transport deadline caps the module deadline to prevent cancellation before purge.
    // A module deadline beyond the transport deadline reopens the cancel-before-purge race.
    // A remainder at or below the cleanup margin leaves the module no workable budget.
    // Leaving the chunk unbanked keeps it eligible for the next slice.
    const budgetMs = Math.min(
        CLASSIFY_MODULE_RUN_TIMEOUT_MS,
        Math.min(sliceDeadline, args.deadline) - Date.now(),
    );
    if (budgetMs <= CLASSIFY_MODULE_PURGE_MARGIN_MS) {
        log("[dreamer] classify: slice budget expired before the module call; chunk left unbanked");
        return null;
    }
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
                model_chain: [...modelChain],
                timeout_ms: budgetMs - CLASSIFY_MODULE_PURGE_MARGIN_MS,
                items: chunk.map((claim) => ({
                    public_claim_id: claim.publicClaimId,
                    revision_locator: claim.revisionLocator,
                    content_digest: claim.contentDigest,
                    mutation_token: claim.mutationToken,
                })),
            },
        },
        signal,
        timeoutMs: budgetMs,
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
