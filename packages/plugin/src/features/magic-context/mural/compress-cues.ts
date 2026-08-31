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
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { type LeaseAcquisition, runLeaseGuardedWrite, startLeaseHeartbeat } from "../dreamer/lease";
import { assertManifestCoversExactly } from "../dreamer/manifest-parser";
import {
    DreamerProviderOutputFailureError,
    providerOutputFailureFromInvalidManifest,
} from "../dreamer/provider-output-failure";
import type { ProjectMemoryClaimSnapshot } from "../memory/storage-claim-current-state";
import {
    readProjectMemoryCurrentState,
    resolveProjectIdsForIdentities,
} from "../memory/storage-claim-current-state";
import { computeWorkspaceEpochFingerprint } from "../workspaces";
import {
    buildCompressCuesPrompt,
    COMPRESS_CUES_SYSTEM_PROMPT,
    type CompressCuesPromptMemory,
    cueBudgetFor,
    parseCuesManifest,
} from "./compress-cues-prompt";
import { validateCue } from "./cue-validation";
import {
    claimNeedsCue,
    getClaimMuralCueStates,
    recordClaimMuralCueRejection,
    setClaimMuralCue,
} from "./storage-mural-cues";

/**
 * The host renders one prompt per chunk for memories with missing or stale cues.
 * A zero-tool agent emits one <cues> XML manifest per chunk.
 * The host validates each cue and writes only mural_cue.
 * resolveMural and renderMural deterministically select, rank, and pack memories.
 *
 * The gate includes memories whose mural_cue is NULL or whose mural_cue_hash differs from sha256(content).
 * Each successful memory write persists independently, so later runs retry only remaining gated memories.
 *
 */

/**
 * The limit bounds peak context and rework after partial runs. */
export const COMPRESS_CUES_CHUNK_SIZE = 40;

/** A chunk's even-split time slice can fall below CHUNK_TIMEOUT_FLOOR_MS.
 * runCompressCues divides the remaining deadline among pending chunks.
 * A timed-out chunk contributes zero cues.
 * The run stops when its remaining budget is below the floor.
 * The run preserves completed progress rather than starting a sub-floor chunk. */
export const CHUNK_TIMEOUT_FLOOR_MS = 240_000;

/** The latch stops launching child sessions after three validation failures for the same content hash.
 * */
export const CUE_REJECTION_LATCH_THRESHOLD = 3;

/** The run stops after two consecutive timeout-class chunk failures.
 * Stopping repeated timeouts preserves the remaining chunk budget.
 * */
const CONSECUTIVE_TIMEOUT_LIMIT = 2;

export interface CompressCuesArgs {
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
    onProgress?: (processed: number) => void;
}

/** The run loop uses the failure class to decide whether to continue.
 * "timeout" means the model did not finish within its time slice.
 * "other" covers validation failures, including bad or missing manifests and length-cap violations, plus provider errors.
 * Validation and provider failures leave the chunk eligible for retry on the next run. */
type ChunkFailureClass = "timeout" | "other";

interface ChunkOutcome {
    compressed: number;
    skipped: number;
    /** failure is present only when the chunk fails.
     * failure records elapsed time for logging.
     * The elapsed time supports chunk-size tuning. */
    failure?: {
        class: ChunkFailureClass;
        brief: string;
        elapsedMs: number;
    };
}

export interface CompressCuesResult {
    /** Cues written this run (memories whose cue moved from missing/stale to set). */
    compressed: number;
    /** Cues the model returned that failed per-cue validation and were skipped. */
    skipped: number;
    chunks: number;
    remaining: number;
    complete: boolean;
}

/**
 * The revision locator captured at selection prevents adopting a cue after the claim changes.
 * If a claim is revised after selection, its stored locator does not match the new revision.
 *  resolveMural excludes the cue and the gate re-selects the claim next run
 * The gate never adopts a cue for content that was not compressed. */
interface CueCandidate {
    item: ProjectMemoryClaimSnapshot;
}

function toPromptMemory(candidate: CueCandidate): CompressCuesPromptMemory {
    const item = candidate.item;
    return {
        id: item.publicClaimId,
        category: item.category,
        importance: item.importance,
        content: item.content,
    };
}

function stripOwnIdToken(value: string, ownId: string): string {
    return value.replaceAll(ownId, "");
}

/** The function truncates by code-point budget and prefers a complete word when available. */
function truncateCue(value: string, budget: number): string {
    const trimmed = value.trim();
    const codepoints = [...trimmed];
    if (codepoints.length <= budget) return trimmed;
    const prefix = codepoints.slice(0, budget).join("");
    const boundary = prefix.search(/\s+\S*$/);
    return (boundary > 0 ? prefix.slice(0, boundary) : prefix).trim();
}

function sanitizeCue(value: string, candidate: CueCandidate): string {
    return truncateCue(
        stripOwnIdToken(value, candidate.item.publicClaimId),
        cueBudgetFor(candidate.item.importance),
    );
}

/**
 * The final model candidate is validated before fallback candidates.
 * The fallback uses source content only when the final model candidate fails validation.
 */
function deterministicFallbackCue(candidate: CueCandidate, lastCandidate: string): string {
    const importance = candidate.item.importance;
    const budget = cueBudgetFor(importance);
    const sanitizedCandidate = sanitizeCue(lastCandidate, candidate);
    if (validateCue(sanitizedCandidate, importance, candidate.item.publicClaimId) === null) {
        return sanitizedCandidate;
    }

    const sourceSlice = sanitizeCue(candidate.item.content, candidate);
    if (validateCue(sourceSlice, importance, candidate.item.publicClaimId) === null) {
        return sourceSlice;
    }

    // Source content can contain grammar markers or unmatched parentheses.
    const grammarSafe = truncateCue(
        sourceSlice
            .replaceAll("⊘", "")
            .replace(/[()]/g, "")
            .replace(/\b(?:must not|never|without|instead of|exclude|excludes)\b/gi, "")
            .replace(/\s+/g, " "),
        budget,
    );
    if (validateCue(grammarSafe, importance, candidate.item.publicClaimId) === null) {
        return grammarSafe;
    }

    return "memory";
}

/** The function selects claims whose cues are missing or stale because their locator or renderer epoch differs.
 * Cue compression sends claim content to a child-model prompt, which is an automatic surface.
 * The candidate pool uses the provider's `auto_inject` decision before any limit is applied.
 * */
function selectCandidates(db: Database, projectIdentity: string): CueCandidate[] {
    const projectIds = resolveProjectIdsForIdentities(db, [projectIdentity]);
    if (projectIds.length === 0) return [];
    const workspaceEpoch = computeWorkspaceEpochFingerprint(db, [projectIdentity]);
    let items: ProjectMemoryClaimSnapshot[] | null = null;
    for (let attempt = 0; attempt < 2 && items === null; attempt += 1) {
        const result = readProjectMemoryCurrentState(db, {
            projectIds,
            workspaceEpoch,
            workspaceIdentities: [projectIdentity],
            surface: "auto_inject",
        });
        if (result.status === "ok") items = result.items;
    }
    if (items === null) return [];
    const cueState = getClaimMuralCueStates(
        db,
        items.map((item) => item.publicClaimId),
    );
    const candidates: CueCandidate[] = [];
    for (const item of items) {
        if (claimNeedsCue(cueState.get(item.publicClaimId), item.revisionLocator)) {
            candidates.push({ item });
        }
    }
    return candidates;
}

/**
 * */
export function computeChunkSliceMs(remainingMs: number, chunksRemaining: number): number {
    return Math.min(
        remainingMs,
        Math.max(CHUNK_TIMEOUT_FLOOR_MS, Math.floor(remainingMs / chunksRemaining)),
    );
}

export async function runCompressCues(args: CompressCuesArgs): Promise<CompressCuesResult> {
    const candidates = selectCandidates(args.db, args.projectIdentity);
    const result: CompressCuesResult = {
        compressed: 0,
        skipped: 0,
        chunks: 0,
        remaining: candidates.length,
        complete: candidates.length === 0,
    };
    if (candidates.length === 0) {
        log(`[dreamer] compress-cues: nothing to compress for ${args.projectIdentity}`);
        return result;
    }

    const chunks: CueCandidate[][] = [];
    for (let i = 0; i < candidates.length; i += COMPRESS_CUES_CHUNK_SIZE) {
        chunks.push(candidates.slice(i, i + COMPRESS_CUES_CHUNK_SIZE));
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
        let consecutiveTimeouts = 0;
        // The breaker log records timeout-streak elapsed times so operators can size model chunks.
        let timeoutStreakElapsedMs: number[] = [];
        for (let i = 0; i < chunks.length; i += 1) {
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) break;
            if (remainingMs < CHUNK_TIMEOUT_FLOOR_MS) {
                log(
                    `[dreamer] compress-cues: stopping before chunk ${i + 1}/${chunks.length} — remaining budget ${remainingMs}ms is below the ${CHUNK_TIMEOUT_FLOOR_MS}ms chunk floor; banking ${result.compressed} compressed cue(s)`,
                );
                break;
            }
            const sliceMs = computeChunkSliceMs(remainingMs, chunks.length - i);
            const chunk = chunks[i];
            if (!chunk) break;
            const outcome = await compressOneChunk(args, chunk, sliceMs, abortController.signal);
            result.compressed += outcome.compressed;
            result.skipped += outcome.skipped;
            result.remaining -= outcome.compressed;
            result.chunks += 1;
            args.onProgress?.(result.compressed + result.skipped);

            if (outcome.failure?.class === "timeout") {
                consecutiveTimeouts += 1;
                timeoutStreakElapsedMs.push(outcome.failure.elapsedMs);
                if (consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_LIMIT) {
                    log(
                        `[dreamer] compress-cues: circuit breaker tripped — ${consecutiveTimeouts} consecutive chunk timeouts (model too slow for its time slice); per-chunk elapsed [${timeoutStreakElapsedMs.join("ms, ")}ms] vs ${sliceMs}ms slice; stopping run incomplete with ${chunks.length - i - 1} chunk(s) unattempted`,
                    );
                    break;
                }
            } else {
                // Only timeout-class failures increment consecutiveTimeouts.
                consecutiveTimeouts = 0;
                timeoutStreakElapsedMs = [];
            }
        }
        result.complete = result.remaining === 0;
        log(
            `[dreamer] compress-cues: compressed=${result.compressed} skipped=${result.skipped} chunks=${result.chunks} remaining=${result.remaining} complete=${result.complete}`,
        );
        return result;
    } finally {
        heartbeat.stop();
    }
}

/** A timeout-class failure occurs when the model does not finish within its time slice.
 * Validation failures and provider errors are not timeout-class.
 * Length-capped output is not timeout-class.
 * */
function isTimeoutClassError(error: unknown): boolean {
    return error instanceof Error && /^prompt timed out after \d+ms$/.test(error.message);
}

async function compressOneChunk(
    args: CompressCuesArgs,
    chunk: CueCandidate[],
    sliceMs: number,
    signal: AbortSignal,
): Promise<ChunkOutcome> {
    let agentSessionId: string | null = null;
    const startedAt = Date.now();
    try {
        const createResponse = await createChildSessionWithFence({
            client: args.client,
            db: args.db,
            parentSessionId: args.parentSessionId,
            title: "magic-context-dream-compress-cues",
            directory: args.sessionDirectory,
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) throw new Error("Could not create compress-cues session.");

        // Child-session creation can delay later chunks, so re-read selected chunks before prompting.
        // The child-model prompt excludes claims quarantined, rejected, or superseded after selection.
        // The child-model prompt excludes members revised after selection to avoid disclosing bytes outside the frozen snapshot.
        // The provider applies policy before limits and rejects a changed snapshot vector.
        const projectIds = resolveProjectIdsForIdentities(args.db, [args.projectIdentity]);
        const recheck = readProjectMemoryCurrentState(args.db, {
            publicClaimIds: chunk.map((candidate) => candidate.item.publicClaimId),
            projectIds,
            workspaceEpoch: computeWorkspaceEpochFingerprint(args.db, [args.projectIdentity]),
            workspaceIdentities: [args.projectIdentity],
            surface: "auto_inject",
        });
        const currentLocators = new Map(
            recheck.status === "ok"
                ? recheck.items.map((item) => [item.publicClaimId, item.revisionLocator])
                : [],
        );
        const eligibleChunk =
            recheck.status === "ok"
                ? chunk.filter(
                      (candidate) =>
                          currentLocators.get(candidate.item.publicClaimId) ===
                          candidate.item.revisionLocator,
                  )
                : [];
        if (eligibleChunk.length < chunk.length) {
            log(
                `[dreamer] compress-cues chunk dropped ${chunk.length - eligibleChunk.length} member(s) hidden or revised since pool selection`,
            );
        }
        if (eligibleChunk.length === 0) return { compressed: 0, skipped: 0 };
        chunk = eligibleChunk;

        const prompt = buildCompressCuesPrompt({
            projectPath: args.projectIdentity,
            memories: chunk.map(toPromptMemory),
        });

        const run = await shared.promptSyncWithValidatedOutputRetry(
            args.client,
            {
                path: { id: agentSessionId },
                query: { directory: args.sessionDirectory },
                body: {
                    agent: DREAMER_CLASSIFIER_AGENT,
                    system: COMPRESS_CUES_SYSTEM_PROMPT,
                    ...modelBodyField(args.model),
                    parts: [{ type: "text", text: prompt, synthetic: true }],
                },
            },
            {
                timeoutMs: sliceMs,
                signal,
                fallbackModels: args.fallbackModels,
                callContext: "dreamer:compress-cues",
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
                        throw new Error("compress-cues returned length-capped output");
                    }
                    const text = extractLatestAssistantText(messages);
                    if (!text) throw new Error("compress-cues returned no output");
                    // A missing or truncated <cues> root rejects the whole chunk; do not partially apply the reply.
                    try {
                        parseCuesManifest(text);
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

        return applyCues(args, chunk, run.validated);
    } catch (error) {
        const desc = describeError(error);
        log(
            `[dreamer] compress-cues chunk failed: ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        if (signal.aborted || error instanceof DreamerProviderOutputFailureError) throw error;
        return {
            compressed: 0,
            skipped: 0,
            failure: {
                class: isTimeoutClassError(error) ? "timeout" : "other",
                brief: desc.brief,
                elapsedMs: Date.now() - startedAt,
            },
        };
    } finally {
        if (agentSessionId && !shouldKeepSubagents()) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((e: unknown) => {
                    log(`[dreamer] compress-cues session cleanup failed: ${getErrorMessage(e)}`);
                });
        }
    }
}

/**
 */
export function applyCues(
    args: CompressCuesArgs,
    chunk: CueCandidate[],
    manifestText: string,
): { compressed: number; skipped: number } {
    const byId = new Map(chunk.map((candidate) => [candidate.item.publicClaimId, candidate]));
    const parsed = parseCuesManifest(manifestText);
    assertManifestCoversExactly(
        parsed.map((entry) => entry.id),
        new Set(byId.keys()),
        "cues",
    );
    let compressed = 0;
    let skipped = 0;
    runLeaseGuardedWrite(args.db, args.holderId, args.leaseKey, () => {
        for (const entry of parsed) {
            const candidate = byId.get(entry.id);
            if (!candidate) throw new Error(`cues manifest contains unknown id ${entry.id}`);
            const importance = candidate.item.importance;
            const failure = validateCue(entry.cue, importance, candidate.item.publicClaimId);
            if (failure) {
                const rejectionCount = recordClaimMuralCueRejection(args.db, {
                    publicClaimId: candidate.item.publicClaimId,
                    revisionLocator: candidate.item.revisionLocator,
                });
                if (rejectionCount >= CUE_REJECTION_LATCH_THRESHOLD) {
                    const fallback = deterministicFallbackCue(candidate, entry.cue);
                    setClaimMuralCue(args.db, {
                        publicClaimId: candidate.item.publicClaimId,
                        revisionLocator: candidate.item.revisionLocator,
                        cue: fallback,
                    });
                    compressed += 1;
                    log(
                        `[dreamer] compress-cues: fallback cue for claim ${entry.id} (${failure.reason}; ${rejectionCount} rejections; fallback)`,
                    );
                    continue;
                }
                skipped += 1;
                log(
                    `[dreamer] compress-cues: skipped cue for claim ${entry.id} (${failure.reason}; rejection ${rejectionCount}/${CUE_REJECTION_LATCH_THRESHOLD})`,
                );
                continue;
            }
            setClaimMuralCue(args.db, {
                publicClaimId: candidate.item.publicClaimId,
                revisionLocator: candidate.item.revisionLocator,
                cue: entry.cue.trim(),
            });
            compressed += 1;
        }
    });
    return { compressed, skipped };
}
