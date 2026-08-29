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
 * compress-cues: a NON-agentic single-shot transform (classify-memories shape).
 * For each project memory whose cue is missing or stale, the host renders one
 * prompt per chunk, a zero-tool agent emits ONE <cues> XML manifest, and the
 * host validates each cue and applies COLUMN-ONLY writes (mural_cue), either locally
 * under TS authority or through the module facade when MODULE owns memories. No per-memory
 * tool calls; no selection/ranking/packing (those are deterministic
 * in resolveMural / renderMural).
 *
 * Gate: mural_cue IS NULL OR mural_cue_hash != sha256(content). Resumable — cues
 * are written per memory, so a partial run sticks and the next run picks up the
 * remaining gate set.
 *
 * Economics: chunks are small (~40 memories), so after the initial backfill the
 * daily trickle is cheap. First run on a 470-memory pool is ~12 chunks; steady
 * state is a handful of new/edited memories per day.
 */

/** Memories per compress call. Small so peak context stays bounded and a
 *  partial run leaves little re-work; the daily cadence drains any backlog. */
export const COMPRESS_CUES_CHUNK_SIZE = 40;

/** Minimum wall-clock budget a single chunk is allowed before we consider it
 *  doomed. runCompressCues divides the remaining task deadline evenly across the
 *  chunks still to run; on a large backfill (e.g. a 470-memory pool = 12 chunks)
 *  that even split can hand a slow thinking model far less than it needs, so
 *  every chunk times out, contributes 0 cues, and the loop burns the whole
 *  deadline (and model quota) marching through chunks that can never finish.
 *  The floor keeps each attempted chunk's slice at least this large, and if the
 *  remaining budget drops below it we stop the run and bank progress instead of
 *  starting a chunk we already know cannot complete. */
export const CHUNK_TIMEOUT_FLOOR_MS = 240_000;

/** Three validation failures for one content hash are enough to stop spending
 * a child session on a response that is not going to change. */
export const CUE_REJECTION_LATCH_THRESHOLD = 3;

/** How many chunks in a row may fail with a timeout-class error before the run
 *  stops early. A model that is consistently slower than its time slice will
 *  time out every chunk; continuing just burns the remaining chunks and quota.
 *  Two consecutive timeouts is enough to conclude the model cannot keep up
 *  within its slice, while still tolerating a single flaky/transient timeout. */
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

/** How a chunk failed, used by the run loop to decide whether to keep going.
 *  "timeout" means the model did not finish within its time slice; "other"
 *  covers validation failures (bad/missing manifest, length cap) and provider
 *  errors, which keep the existing per-chunk retry-next-run behavior. */
type ChunkFailureClass = "timeout" | "other";

interface ChunkOutcome {
    compressed: number;
    skipped: number;
    /** Present only when the chunk failed. Carries the failure class plus the
     *  measured elapsed time so the run loop can log how long the doomed chunk
     *  actually ran (helps an operator size chunk vs model). */
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

/** A claim selected for (re)compression. The revision locator captured at
 *  SELECTION time is the race guard: if the claim is revised between
 *  selection and write, the stored locator won't match the new revision, so
 *  resolveMural excludes the cue and the gate re-selects the claim next run
 *  — it never adopts a cue for content it wasn't compressed from. */
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

/** Truncate by codepoint budget, preferring a complete word when one exists. */
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
 * Make a deterministic cue after the same response has failed validation three
 * times. The model's final candidate gets first choice; source content is the
 * second choice so a bad polarity or mechanism cannot keep the gate open.
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

    // Source content can itself contain grammar markers or an unmatched
    // parenthesis. Remove only those validator controls as a final deterministic
    // repair; the remaining text is still a bounded slice of the memory.
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

    // Memory content is normally non-empty; keep this guard deterministic for
    // malformed legacy rows while preserving the validator's non-empty rule.
    return "memory";
}

/** Select the claims whose cue is missing or stale (locator or renderer-epoch
 * mismatch). Cue compression sends claim CONTENT to a child-model prompt — an
 * automatic surface — so the pool comes from the provider's `auto_inject`
 * decision, which applies policy before any limit. */
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

/** Compute the wall-clock slice for the next chunk: an even split of the
 *  remaining budget across the chunks still to run, but never below
 *  CHUNK_TIMEOUT_FLOOR_MS (a slice smaller than the model needs guarantees a
 *  timeout) and never more than the budget actually remaining. Exported for
 *  test; the run loop calls this once per chunk. */
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
        // Elapsed time of each chunk in the current consecutive-timeout streak,
        // logged when the breaker trips so an operator can size chunk vs model.
        let timeoutStreakElapsedMs: number[] = [];
        for (let i = 0; i < chunks.length; i += 1) {
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) break;
            // Not enough budget left to give this chunk a fair (>= floor) slice.
            // Starting it would just produce another timeout, so stop here and
            // bank progress: cues already written are durable per memory, and the
            // incomplete result keeps this task transient so cron retries it.
            if (remainingMs < CHUNK_TIMEOUT_FLOOR_MS) {
                log(
                    `[dreamer] compress-cues: stopping before chunk ${i + 1}/${chunks.length} — remaining budget ${remainingMs}ms is below the ${CHUNK_TIMEOUT_FLOOR_MS}ms chunk floor; banking ${result.compressed} compressed cue(s)`,
                );
                break;
            }
            // Even-split the remaining budget across the chunks still to run, but
            // never hand a chunk less than the floor (a slice too small for the
            // model guarantees a timeout).
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
                    // Circuit breaker: the model is consistently slower than its
                    // time slice. Stop now instead of burning the remaining chunks
                    // (and model quota) on attempts that will also time out.
                    log(
                        `[dreamer] compress-cues: circuit breaker tripped — ${consecutiveTimeouts} consecutive chunk timeouts (model too slow for its time slice); per-chunk elapsed [${timeoutStreakElapsedMs.join("ms, ")}ms] vs ${sliceMs}ms slice; stopping run incomplete with ${chunks.length - i - 1} chunk(s) unattempted`,
                    );
                    break;
                }
            } else {
                // A success or a non-timeout failure (validation/provider) breaks
                // the streak: those keep the existing retry-next-run behavior and
                // must not trip the timeout breaker.
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

/** True when a chunk failed because the model did not finish within its time
 *  slice — the "prompt timed out after Nms" error thrown by promptWithTimeout in
 *  shared/model-suggestion-retry. Validation failures (bad/missing manifest,
 *  length-capped output) and provider errors are deliberately NOT timeout-class:
 *  those keep the existing per-chunk retry-next-run behavior and must not trip
 *  the consecutive-timeout circuit breaker. */
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

        // The candidate pool was frozen once at run start; later chunks wait
        // behind provider calls, and child-session creation above is itself
        // an await. A claim quarantined, rejected, or superseded in the
        // meantime must not have its content sent to the child-model prompt,
        // and a member revised after selection must not have its frozen
        // bytes disclosed. Re-read the chunk through the provider immediately
        // before the prompt is built: the provider applies policy before
        // limits and rechecks its snapshot vector, and the revision-locator
        // comparison drops members revised since selection.
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
                    // Fail-closed root parse: a missing/truncated <cues> root rejects
                    // the whole chunk here (no partial apply from a truncated reply).
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
        // A chunk failure is not fatal to the run: other chunks still compress,
        // and this chunk's memories stay NULL and are retried next run. Rethrow
        // only on abort (lease lost / deadline) so the scheduler records it.
        if (signal.aborted || error instanceof DreamerProviderOutputFailureError) throw error;
        // Classify the failure so the run loop can drive the consecutive-timeout
        // circuit breaker. The measured elapsed time lets the operator compare
        // how long the model actually ran against the slice it was given.
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
 * Validate each returned cue independently and write the valid ones into the
 * derived cue table. The first validation failures are skipped (the claim
 * keeps a NULL cue); after the rejection latch trips, a deterministic
 * fallback is written instead of retrying forever. The stored key is the
 * SELECTION-time revision locator, so a claim revised mid-run doesn't adopt
 * a cue compressed from its old content.
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
