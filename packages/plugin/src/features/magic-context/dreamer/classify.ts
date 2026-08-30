import { DREAMER_CLASSIFIER_AGENT } from "../../../agents/dreamer";
import { childSessionMessagesFetcher, createChildSessionWithFence } from "../../../hooks/magic-context/child-session-spawn";
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
    rethrowInvalidManifestAsProviderFailure,
} from "./provider-output-failure";

const MIN_POOL_TO_CLASSIFY = 10;
const FULL_POOL_CEILING = 100;
const STAGE3_ANCHOR_COUNT = 30;
const CLASSIFY_CHUNK_SIZE = 100;
const CLASSIFY_MODULE_RUN_TIMEOUT_MS = 660_000;

/**
 * Mirrors `MAX_CLASSIFY_PROMPT_BYTES` in `crates/mc-module/src/classify.rs`:
 * `dreamer.run_task` refuses a longer `prompt_body` with `payload_too_large`
 * before any producer run. A rejected prompt is rebuilt identically on every
 * scheduled pass, so chunks must be bounded by rendered bytes as well as entry
 * count — a 100-entry bound alone lets content-heavy claims exceed the cap and
 * never classify on any run.
 */
export const MAX_CLASSIFY_PROMPT_BYTES = 256 * 1024;
/** Anchors are calibration aids, not work, so they get the smaller share of
 *  the cap — and they ride EVERY chunk's prompt, so they are bounded once. */
const ANCHOR_PROMPT_BYTE_BUDGET = 48 * 1024;
/** The pool's share: the cap minus the anchor budget, with headroom for the
 *  task template and guidance text that wrap both sections. */
const CHUNK_PROMPT_BYTE_BUDGET = MAX_CLASSIFY_PROMPT_BYTES - ANCHOR_PROMPT_BYTE_BUDGET - 16 * 1024;
/**
 * Upper bound on the fixed text `renderPool`/`renderAnchors` wrap around one
 * entry's variable fields: the bracket, separators, ` revision=`, ` digest=`,
 * the `(current: importance=... scope=... shareable=...)` tail, the newline
 * before the content, and the blank line between entries. The literals total 66
 * bytes and the values this estimate does not otherwise count (importance,
 * scope name, shareable) at most 17, so this leaves slack rather than
 * underestimating — an underestimate is what lets a chunk breach the cap.
 */
const PROMPT_ENTRY_TEMPLATE_BYTES = 128;

/** A conservative bound on one claim's rendered prompt entry. Every variable
 *  field the renderer interpolates is counted, so the sum can only exceed what
 *  the prompt actually spends on this claim. */
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
 * The margin between the transport request budget and the `timeout_ms` handed
 * to the module.
 *
 * The module's deadline bounds its start, await, and re-drain windows, so its
 * last producer window closes at `timeout_ms`. The work after that is bounded
 * but not free: `purge_session` wraps `session.delete` plus `close` in the
 * producer's 30s request timeout, the host then reaps the Broca subprocess
 * group under its 5s SIGTERM-to-SIGKILL grace, and the ledger write and
 * response dispatch need slack on top. Equal budgets make the transport time
 * out first, and that cancel lands between the producer run and the purge:
 * nothing is recorded, no fallback model can complete, and the attempt's
 * billable run stays alive holding the memory-pool prompt.
 */
const CLASSIFY_MODULE_PURGE_MARGIN_MS = 40_000;
/**
 * A chunk slice below this floor cannot host a real module call: the purge
 * margin alone consumes 40s and a model needs minutes on top. Equal division
 * of the remaining deadline across many chunks can push every slice under the
 * margin, so flooring the slice runs the head of the pool with workable
 * budgets and defers the tail to the next pass — instead of handing later
 * chunks progressively larger slices while the head of a stable ordering is
 * skipped on every pass.
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
    /** Ordered classify model chain (task override → dreamer default → fallbacks)
     *  the module route sends verbatim; the TypeScript provider path keeps using
     *  model/fallbackModels instead. The dreamer-level default reaches classify
     *  only through this chain, so dropping it silently removes that rung. */
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
 * The module route's model selection, resolved from `modelChain` alone.
 *
 * Module-backed classify cannot inherit the session's model the way the
 * non-module path does: `dreamer.run_task` requires an explicit canonical
 * `provider/model` chain and rejects a payload without one, and no canonical
 * string for the session default exists on this side of the boundary. So an
 * empty chain is a permanent configuration failure, and the message names every
 * key that can supply one. The wording stays outside `classifyFailure`'s
 * transient-retry vocabulary so the task advances to its next cron slot instead
 * of hot-retrying a config error.
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
 * Split the pool into chunks bounded by BOTH entry count and rendered prompt
 * bytes. A claim whose own entry exceeds the whole byte budget cannot fit any
 * chunk however the pool is split, so it is reported separately rather than
 * put in a chunk that is guaranteed to be refused. An infinite budget degrades
 * to count-only chunking, which is what the TypeScript child path wants: it has
 * no `prompt_body` cap, and capping it would exclude claims a provider can
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
 * Keep stratified anchors while they fit the anchor byte budget, skipping only
 * the individual anchors that do not fit so the remaining stratification
 * survives. Anchors are calibration aids: dropping some degrades calibration,
 * while keeping them all can push every chunk's prompt past the module's cap.
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
 * A claim too large for any chunk is skipped, and the skip is recorded as a
 * durable zero-effect rejection receipt rather than only logged.
 *
 * The alternatives are worse. Truncating the content would score bytes the
 * claim does not hold while the manifest binding still names the full
 * revision's digest, so the receipt would assert a classification of content
 * nobody classified. Sending it alone and letting the module refuse spends a
 * `payload_too_large` round-trip on every scheduled pass and, because a module
 * chunk failure is transient, fails the whole task into a hot retry loop.
 *
 * Skipping is the only option that lets the rest of the pool make progress,
 * but a silent skip is the defect this replaces: the receipt names the byte
 * overflow and the cap, so an operator can find the claim and shorten it
 * instead of watching it never classify.
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

    // Pre-flight the module route's model chain before any child session or
    // module call. Thrown here it stays a permanent failure; thrown from inside
    // the per-chunk try below it would be wrapped in DreamerModuleFailureError,
    // whose transient=true would hot-retry a configuration error forever.
    if (moduleRoute) moduleClassifyModelChain(args);

    const { chunks, oversized } = chunkByCountAndBytes(
        toClassify,
        moduleRoute ? CHUNK_PROMPT_BYTE_BUDGET : Number.POSITIVE_INFINITY,
    );
    if (oversized.length > 0) {
        recordOversizedClaims(args, oversized);
        // Counting a claim that can never fit as remaining would keep every
        // pass permanently incomplete and hot-retry forever.
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
            // Floored so equal division across a long backlog cannot hand every
            // chunk an unworkable slice; the tail defers to the next pass
            // instead of the head starving on every pass.
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
                // The slice could not reserve the module's cleanup margin, so
                // the overall deadline is effectively spent and every later
                // chunk would fare no better. Ending the pass keeps the stable
                // pool ordering fair: the same chunks lead the next pass.
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
 * One chunk's classification, or `null` when the module route's slice could not
 * reserve the cleanup margin — the chunk stays unbanked and is not a completed
 * invocation, so the caller ends the pass instead of skipping this chunk and
 * classifying later ones out of order.
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
                fetchOutput: childSessionMessagesFetcher(
                    args.client,
                    agentSessionId as string,
                    args.sessionDirectory,
                    50,
                ),
                validateOutput: (messages) => {
                    if (hasLengthCappedOutput(messages)) {
                        throw new Error("classify returned length-capped output");
                    }
                    const text = extractLatestAssistantText(messages);
                    if (!text) throw new Error("classify returned no output");
                    rawManifest = text;
                    rethrowInvalidManifestAsProviderFailure(messages, text, () => {
                        validateClassifyManifest(
                            text,
                            new Set(chunk.map((claim) => claim.publicClaimId)),
                        );
                    });
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
    // Both budgets below derive from this one capped remainder. Capping only
    // the transport would let a long slice hand the module a deadline that
    // outlives the transport and reopen the cancel-before-purge race, and a
    // remainder at or below the margin leaves the module no workable budget at
    // all — leaving the chunk unbanked keeps it eligible on the next slice.
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
                // `dreamer.run_task` rejects a classify payload without a
                // non-empty canonical chain, so this is a required field, not a
                // hint. It is the only path by which the dreamer-level default
                // model reaches classify.
                model_chain: [...modelChain],
                // Strictly shorter than the transport budget below so the
                // module's own deadline machinery — not a transport cancel that
                // aborts the handler mid-cleanup — ends an over-budget run,
                // records its outcome, and purges the attempt session. The guard
                // above keeps this positive.
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
        // The module drives a full producer run (model call included) before
        // replying, so this request carries the classify slice budget rather
        // than the transport default.
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
