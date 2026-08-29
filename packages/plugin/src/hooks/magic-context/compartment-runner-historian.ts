import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HISTORIAN_AGENT, HISTORIAN_EDITOR_AGENT } from "../../agents/historian";
import { DEFAULT_HISTORIAN_TIMEOUT_MS } from "../../config/schema/magic-context";
import { openDatabase } from "../../features/magic-context/storage";
import type { SubagentKind } from "../../features/magic-context/storage-subagent-invocations";
import {
    recordChildInvocation,
    sumTokensFromChildMessages,
} from "../../features/magic-context/subagent-token-capture";
import type { PluginContext } from "../../plugin/types";
import * as shared from "../../shared";
import {
    extractLatestAssistantText,
    hasLengthCappedOutput,
} from "../../shared/assistant-message-extractor";
import {
    ensureCortexKitArtifactGitignore,
    getProjectMagicContextHistorianDir,
} from "../../shared/data-path";
import { describeError, getErrorMessage } from "../../shared/error-message";
import { shouldKeepSubagents } from "../../shared/keep-subagents";
import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import { createChildSessionWithFence } from "./child-session-spawn";
import { buildHistorianEditorPrompt } from "./compartment-prompt";
import type {
    HistorianProgressCallbacks,
    HistorianRunResult,
    StoredCompartmentRange,
    ValidatedHistorianPassResult,
} from "./compartment-runner-types";
import {
    buildHistorianRepairPrompt,
    type HistorianValidationChunk,
    validateHistorianOutput,
} from "./compartment-runner-validation";

// Intentionally kept: historian validation failure dumps are preserved for
// debugging. They land in the project-local historian dir
// (<project>/.opencode/magic-context/historian/) so they sit inside the
// project boundary OpenCode's permission system already trusts AND so users
// debugging a failed run can find dumps next to the project they belong to.
// Dumps are kept deliberately for debugging and survive until manual
// cleanup.
function historianResponseDumpDir(directory: string): string {
    return getProjectMagicContextHistorianDir(directory);
}
const MAX_HISTORIAN_RETRIES = 2;

interface HistorianModelOverride {
    providerID: string;
    modelID: string;
}

const HISTORIAN_REASONING_PART_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

/**
 * Read reasoning only for the historian after the normal text extractor found no text.
 * Historian output still passes the compartment parser and validator before publication;
 * shared extractors remain text-only so fail-closed dreamer manifest parsers never accept
 * a model's private reasoning as normal task output.
 *
 * Exported so the historian eval lane's replay runner captures the same
 * artifact production validated (a reasoning-only payload must yield the same
 * text) instead of maintaining a second extractor.
 */
export function extractLatestHistorianReasoning(messages: unknown): string | null {
    if (!Array.isArray(messages)) return null;

    const latest = messages
        .filter(
            (message): message is Record<string, unknown> =>
                isRecord(message) && isRecord(message.info) && message.info.role === "assistant",
        )
        .sort(
            (left, right) => historianMessageCreatedAt(right) - historianMessageCreatedAt(left),
        )[0];
    if (!latest || !Array.isArray(latest.parts)) return null;

    return (
        latest.parts
            .filter(isHistorianReasoningPart)
            .map((part) => part.text)
            .join("\n") || null
    );
}

function isHistorianReasoningPart(part: unknown): part is { type: string; text: string } {
    return (
        isRecord(part) &&
        typeof part.type === "string" &&
        HISTORIAN_REASONING_PART_TYPES.has(part.type) &&
        typeof part.text === "string" &&
        part.text.length > 0
    );
}

function historianMessageCreatedAt(message: Record<string, unknown>): number {
    if (!isRecord(message.info) || !isRecord(message.info.time)) return 0;
    return typeof message.info.time.created === "number" ? message.info.time.created : 0;
}

export async function runValidatedHistorianPass(args: {
    client: PluginContext["client"];
    db: Database;
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    chunk: HistorianValidationChunk;
    priorCompartments: StoredCompartmentRange[];
    sequenceOffset: number;
    dumpLabelBase: string;
    timeoutMs?: number;
    fallbackModelId?: string;
    /**
     * Resolved historian fallback chain ("provider/modelID" entries). When the
     * primary historian model fails (auth, model-not-found, transient network),
     * each fallback is tried in order. Independent of `fallbackModelId` (which
     * is a last-ditch single-model retry against the active session model).
     */
    fallbackModels?: readonly string[];
    callbacks?: HistorianProgressCallbacks;
    responseDumpObserver?: (dumpPath: string) => void;
    /** When true, run a second editor pass after successful historian output
     *  to clean low-signal U: lines and cross-compartment duplicates. If editor
     *  validation fails, falls back to the draft (first-pass) result. */
    twoPass?: boolean;
    subagentKind?: SubagentKind;
    agentId?: string;
    language?: string;
}): Promise<ValidatedHistorianPassResult> {
    const firstRun = await runHistorianPrompt({
        ...args,
        dumpLabel: `${args.dumpLabelBase}-initial`,
        agentId: args.agentId,
    });
    if (!firstRun.ok || !firstRun.result) {
        return runFallbackHistorianPass({
            ...args,
            prompt: args.prompt,
            error: firstRun.error ?? "historian run failed",
            dumpPaths: [firstRun.dumpPath],
        });
    }

    const firstValidation = validateHistorianOutput(
        firstRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (firstValidation.ok) {
        const finalResult = args.twoPass
            ? await runEditorPassOrFallback({
                  ...args,
                  draftXml: firstRun.result,
                  draftValidation: firstValidation,
                  draftDumpPath: firstRun.dumpPath,
                  draftInvocationId: firstRun.invocationId ?? null,
              })
            : { ...firstValidation, invocationId: firstRun.invocationId ?? null };
        cleanupHistorianDump(args.parentSessionId, firstRun.dumpPath);
        return finalResult;
    }

    await args.callbacks?.onRepairRetry?.(firstValidation.error ?? "invalid compartment output");
    const repairPrompt = buildHistorianRepairPrompt(
        args.prompt,
        firstRun.result,
        firstValidation.error ?? "invalid compartment output",
        args.language,
    );
    const repairRun = await runHistorianPrompt({
        ...args,
        prompt: repairPrompt,
        dumpLabel: `${args.dumpLabelBase}-repair`,
        agentId: args.agentId,
    });
    if (!repairRun.ok || !repairRun.result) {
        return runFallbackHistorianPass({
            ...args,
            prompt: repairPrompt,
            error: repairRun.error ?? "historian repair run failed",
            dumpPaths: [firstRun.dumpPath, repairRun.dumpPath],
        });
    }

    const repairValidation = validateHistorianOutput(
        repairRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (repairValidation.ok) {
        const finalResult = args.twoPass
            ? await runEditorPassOrFallback({
                  ...args,
                  draftXml: repairRun.result,
                  draftValidation: repairValidation,
                  draftDumpPath: repairRun.dumpPath,
                  draftInvocationId: repairRun.invocationId ?? null,
              })
            : { ...repairValidation, invocationId: repairRun.invocationId ?? null };
        // Keep firstRun.dumpPath (initial failure) for debugging.
        // Only cleanup the successful repair run's dump.
        cleanupHistorianDump(args.parentSessionId, repairRun.dumpPath);
        return finalResult;
    }

    return runFallbackHistorianPass({
        ...args,
        prompt: repairPrompt,
        error: repairValidation.error ?? "invalid compartment output",
        dumpPaths: [firstRun.dumpPath, repairRun.dumpPath],
    });
}

/**
 * Run the historian-editor agent on a validated historian draft. Returns the
 * editor's validated result if successful; falls back to the draft on any
 * failure (editor call, validation, or invalid structure). Editor can never
 * regress behavior — worst case we return the same validated draft.
 *
 * Fallback-chain policy (Audit Finding #10 clarification): the editor pass
 * deliberately does NOT receive `fallbackModels`. If the configured editor
 * model fails (auth, model-not-found, transient network, or the editor's own
 * output fails validation), the function returns the already-validated draft
 * unchanged. Iterating through fallback models here would cost extra LLM
 * calls per chunk for no compression benefit — the draft is already known to
 * be valid and the editor pass is purely a polish step. Letting the editor
 * silently no-op back to the draft is the cheaper and safer behavior.
 */
async function runEditorPassOrFallback(args: {
    client: PluginContext["client"];
    db: Database;
    parentSessionId: string;
    sessionDirectory: string;
    chunk: {
        startIndex: number;
        endIndex: number;
        lines: Array<{ ordinal: number; messageId: string }>;
        toolOnlyRanges?: ReadonlyArray<{ start: number; end: number }>;
    };
    priorCompartments: StoredCompartmentRange[];
    sequenceOffset: number;
    dumpLabelBase: string;
    timeoutMs?: number;
    draftXml: string;
    draftValidation: ValidatedHistorianPassResult;
    draftDumpPath?: string;
    draftInvocationId?: number | null;
    responseDumpObserver?: (dumpPath: string) => void;
}): Promise<ValidatedHistorianPassResult> {
    shared.sessionLog(args.parentSessionId, "historian two-pass: running editor on draft");
    const editorRun = await runHistorianPrompt({
        client: args.client,
        db: args.db,
        parentSessionId: args.parentSessionId,
        sessionDirectory: args.sessionDirectory,
        prompt: buildHistorianEditorPrompt(args.draftXml),
        timeoutMs: args.timeoutMs,
        dumpLabel: `${args.dumpLabelBase}-editor`,
        agentId: HISTORIAN_EDITOR_AGENT,
        parentInvocationId: args.draftInvocationId ?? null,
        responseDumpObserver: args.responseDumpObserver,
    });

    if (!editorRun.ok || !editorRun.result) {
        shared.sessionLog(args.parentSessionId, "historian two-pass: editor call failed", {
            error: editorRun.error,
        });
        // Editor failed → keep the validated draft; FK links to the draft run.
        return { ...args.draftValidation, invocationId: args.draftInvocationId ?? null };
    }

    const editorValidation = validateHistorianOutput(
        editorRun.result,
        args.parentSessionId,
        args.chunk,
        args.priorCompartments,
        args.sequenceOffset,
    );
    if (!editorValidation.ok) {
        shared.sessionLog(
            args.parentSessionId,
            "historian two-pass: editor validation failed, falling back to draft",
            { error: editorValidation.error },
        );
        // Editor output was bad — keep editor dump for debugging.
        return { ...args.draftValidation, invocationId: args.draftInvocationId ?? null };
    }

    cleanupHistorianDump(args.parentSessionId, editorRun.dumpPath);
    shared.sessionLog(args.parentSessionId, "historian two-pass: editor accepted");
    return { ...editorValidation, invocationId: editorRun.invocationId ?? null };
}

async function runHistorianPrompt(args: {
    client: PluginContext["client"];
    db: Database;
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    timeoutMs?: number;
    dumpLabel?: string;
    modelOverride?: HistorianModelOverride;
    /** Agent identifier to route the request to. Defaults to HISTORIAN_AGENT.
     *  Use HISTORIAN_EDITOR_AGENT for the second pass in two-pass mode. */
    agentId?: string;
    /** Resolved historian fallback chain (forwarded to the prompt helper). */
    fallbackModels?: readonly string[];
    subagentKind?: SubagentKind;
    parentInvocationId?: number | null;
    responseDumpObserver?: (dumpPath: string) => void;
}): Promise<HistorianRunResult> {
    const {
        client,
        db,
        parentSessionId,
        sessionDirectory,
        prompt,
        timeoutMs,
        dumpLabel,
        modelOverride,
        agentId = HISTORIAN_AGENT,
        fallbackModels,
        subagentKind,
        parentInvocationId,
        responseDumpObserver,
    } = args;
    let agentSessionId: string | null = null;
    const startedAt = Date.now();
    let invocationRecorded = false;
    // Keep FAILED historian child sessions for debugging (the model output, the
    // exact prompt, and the error are all inspectable in the child session). Only
    // delete on SUCCESS, where the result is already persisted as a compartment.
    let outcomeOk = false;

    const recordInvocation = (params: {
        status: "completed" | "failed" | "aborted";
        messages?: unknown[];
        error?: unknown;
    }): number | null => {
        if (invocationRecorded) return null;
        invocationRecorded = true;
        return recordChildInvocation({
            db: openDatabase(),
            parentSessionId,
            harness: "opencode",
            subagent:
                agentId === HISTORIAN_EDITOR_AGENT
                    ? "historian_editor"
                    : (subagentKind ?? "historian"),
            startedAt,
            status: params.status,
            messages: params.messages,
            error: params.error,
            parentInvocationId:
                agentId === HISTORIAN_EDITOR_AGENT ? (parentInvocationId ?? null) : null,
        });
    };

    try {
        shared.sessionLog(
            parentSessionId,
            `historian: creating child session (agent=${agentId}, model=${modelOverride ? `${modelOverride.providerID}/${modelOverride.modelID}` : `agent:${agentId}`})`,
        );
        const createResponse = await createChildSessionWithFence({
            client,
            db,
            parentSessionId,
            title: "magic-context-compartment",
            directory: sessionDirectory,
        });

        const createdSession = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            { preferResponseOnMissingData: true },
        );
        agentSessionId = typeof createdSession?.id === "string" ? createdSession.id : null;

        if (!agentSessionId) {
            recordInvocation({
                status: "failed",
                error: "Historian could not create its child session.",
            });
            return { ok: false, error: "Historian could not create its child session." };
        }

        for (let retryIndex = 0; retryIndex <= MAX_HISTORIAN_RETRIES; retryIndex += 1) {
            try {
                await shared.promptSyncWithModelSuggestionRetry(
                    client,
                    {
                        path: { id: agentSessionId },
                        query: { directory: sessionDirectory },
                        body: {
                            // Use the specified agent (HISTORIAN_AGENT by default, or
                            // HISTORIAN_EDITOR_AGENT for two-pass editor pass) so OpenCode
                            // loads the right system prompt. When modelOverride is set,
                            // OpenCode uses the override model but still loads the agent's
                            // registered system prompt.
                            agent: agentId,
                            ...(modelOverride ? { model: modelOverride } : {}),
                            // synthetic: true keeps this big internal prompt out of the
                            // OpenCode TUI subagent pane (would otherwise render as a huge
                            // unreadable visible message). The historian
                            // model still receives the part because toModelMessages only
                            // filters `ignored`, not `synthetic`.
                            parts: [{ type: "text", text: prompt, synthetic: true }],
                        },
                    },
                    {
                        timeoutMs: timeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
                        // When modelOverride is set we're already in the last-ditch retry
                        // path; iterating fallbacks again would be redundant.
                        fallbackModels: modelOverride ? undefined : fallbackModels,
                        callContext:
                            agentId === HISTORIAN_EDITOR_AGENT ? "historian:editor" : "historian",
                    },
                );
                shared.sessionLog(
                    parentSessionId,
                    `historian: prompt completed (attempt ${retryIndex + 1}/${MAX_HISTORIAN_RETRIES + 1})`,
                );
                break;
            } catch (error: unknown) {
                const errorMsg = getErrorMessage(error);
                shared.sessionLog(
                    parentSessionId,
                    `historian: prompt attempt ${retryIndex + 1} failed: ${errorMsg}`,
                );
                const shouldRetry =
                    retryIndex < MAX_HISTORIAN_RETRIES && isTransientHistorianPromptError(errorMsg);
                if (!shouldRetry) {
                    throw error;
                }

                const backoffMs = getHistorianRetryBackoffMs(retryIndex);
                shared.sessionLog(
                    parentSessionId,
                    `historian retry ${retryIndex + 1}/${MAX_HISTORIAN_RETRIES} after ${backoffMs}ms: ${errorMsg}`,
                );
                await sleep(backoffMs);
            }
        }

        const messagesResponse = await client.session.messages({
            path: { id: agentSessionId },
            query: { directory: sessionDirectory, limit: 50 },
        });
        const messages = shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
            preferResponseOnMissingData: true,
        });
        const invocationId = recordInvocation({ status: "completed", messages });
        const lengthCapped = hasLengthCappedOutput(messages);
        const textResult = extractLatestAssistantText(messages);
        const reasoningResult = textResult ? null : extractLatestHistorianReasoning(messages);
        if (!textResult && reasoningResult && lengthCapped) {
            const outputTokens = sumTokensFromChildMessages(messages).output;
            return {
                ok: false,
                error: `historian output length-capped at ${outputTokens} tokens (all reasoning, no text) — set historian.maxTokens or route historian.model to a low-reasoning lane/variant`,
                invocationId: invocationId ?? undefined,
            };
        }

        const result = textResult ?? reasoningResult;
        if (!result) {
            return {
                ok: false,
                error: "Historian returned no assistant output.",
                invocationId: invocationId ?? undefined,
            };
        }

        const dumpPath = dumpHistorianResponse(
            parentSessionId,
            sessionDirectory,
            dumpLabel ?? "historian-response",
            result,
        );
        if (dumpPath) {
            try {
                responseDumpObserver?.(dumpPath);
            } catch (observerError: unknown) {
                // The dump is already durably written and the model output is
                // valid; an observer fault must not be reported as a historian
                // failure, which would discard the result and force fallback.
                shared.sessionLog(
                    parentSessionId,
                    `historian response dump observer failed: ${describeError(observerError).brief}`,
                );
            }
        }
        outcomeOk = true;
        return { ok: true, result, dumpPath, invocationId: invocationId ?? undefined };
    } catch (modelError: unknown) {
        const desc = describeError(modelError);
        shared.sessionLog(
            parentSessionId,
            `historian prompt failed: ${desc.brief} promptLength=${prompt.length}${desc.stackHead ? ` stackHead="${desc.stackHead}"` : ""}`,
        );
        recordInvocation({ status: "failed", error: modelError });
        return {
            ok: false,
            error: `Historian failed while processing this session: ${desc.brief}`,
        };
    } finally {
        // Delete the child session ONLY on success. On failure, keep it so the
        // failed model output / prompt / error can be inspected for debugging
        // (the run is already recorded as failed in subagent_invocations +
        // historian_runs; the live child session is the missing piece). A periodic
        // sweep can GC old failed child sessions later if needed.
        if (agentSessionId && outcomeOk && !shouldKeepSubagents()) {
            await client.session.delete({ path: { id: agentSessionId } }).catch((e: unknown) => {
                shared.sessionLog(
                    parentSessionId,
                    "compartment agent: session cleanup failed",
                    getErrorMessage(e),
                );
            });
        } else if (agentSessionId && (!outcomeOk || shouldKeepSubagents())) {
            shared.sessionLog(
                parentSessionId,
                `historian: KEEPING child session ${agentSessionId} (${outcomeOk ? "keep_subagents" : "failed"}) — not deleted`,
            );
        }
    }
}

async function runFallbackHistorianPass(args: {
    client: PluginContext["client"];
    db: Database;
    parentSessionId: string;
    sessionDirectory: string;
    prompt: string;
    chunk: {
        startIndex: number;
        endIndex: number;
        lines: Array<{ ordinal: number; messageId: string }>;
        toolOnlyRanges?: ReadonlyArray<{ start: number; end: number }>;
    };
    priorCompartments: StoredCompartmentRange[];
    sequenceOffset: number;
    dumpLabelBase: string;
    timeoutMs?: number;
    /**
     * Configured historian fallback chain (e.g. `anthropic/claude-sonnet-4-6`),
     * tried IN ORDER before the session-model last resort. Each candidate's
     * output is validated — empty or unparseable output (e.g. a misconfigured
     * primary that returns nothing, or a model that replies conversationally
     * instead of emitting compartments) escalates to the next candidate rather
     * than failing the whole pass.
     */
    fallbackModels?: readonly string[];
    /**
     * The live session provider/model, used as the absolute last resort AFTER
     * the configured chain is exhausted.
     */
    fallbackModelId?: string;
    callbacks?: HistorianProgressCallbacks;
    agentId?: string;
    responseDumpObserver?: (dumpPath: string) => void;
    error: string;
    dumpPaths: Array<string | undefined>;
}): Promise<ValidatedHistorianPassResult> {
    // Ordered escalation that matches the intended fallback policy:
    //   configured fallback_models (in order)  →  live session model (last resort)
    // The primary model already ran (and was repaired) before we get here.
    // Validation gates EVERY candidate, so a model that returns no usable
    // compartments escalates to the next instead of ending the pass — this is
    // exactly the path a misconfigured/empty-returning primary needs, since an
    // empty-but-successful response never throws and so never triggers the
    // throw-based chain inside the prompt call.
    const seen = new Set<string>();
    const chain: string[] = [];
    for (const candidate of [...(args.fallbackModels ?? []), args.fallbackModelId ?? ""]) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        chain.push(candidate);
    }
    if (chain.length === 0) {
        return { ok: false, error: args.error };
    }

    let lastError = args.error;
    for (let i = 0; i < chain.length; i += 1) {
        const modelId = chain[i];
        const modelOverride = parseModelOverride(modelId);
        if (!modelOverride) continue;

        const isSessionModelLastResort = modelId === args.fallbackModelId && i === chain.length - 1;
        shared.sessionLog(
            args.parentSessionId,
            `compartment agent: retrying historian with ${modelId} (${
                isSessionModelLastResort ? "session-model last resort" : "configured fallback"
            } ${i + 1}/${chain.length})`,
        );
        args.callbacks?.onModelFallback?.(modelId, i + 1, chain.length);

        const fallbackRun = await runHistorianPrompt({
            client: args.client,
            db: args.db,
            parentSessionId: args.parentSessionId,
            sessionDirectory: args.sessionDirectory,
            prompt: args.prompt,
            timeoutMs: args.timeoutMs,
            dumpLabel: `${args.dumpLabelBase}-fallback-${i + 1}`,
            modelOverride,
            agentId: args.agentId,
            responseDumpObserver: args.responseDumpObserver,
        });
        if (!fallbackRun.ok || !fallbackRun.result) {
            lastError = fallbackRun.error ?? lastError;
            continue;
        }

        const fallbackValidation = validateHistorianOutput(
            fallbackRun.result,
            args.parentSessionId,
            args.chunk,
            args.priorCompartments,
            args.sequenceOffset,
        );
        if (fallbackValidation.ok) {
            // Only cleanup the successful run's dump. Prior failed dumps
            // (args.dumpPaths + earlier chain attempts) are kept for debugging.
            cleanupHistorianDump(args.parentSessionId, fallbackRun.dumpPath);
            return { ...fallbackValidation, invocationId: fallbackRun.invocationId ?? null };
        }
        lastError = fallbackValidation.error ?? lastError;
        // Keep the dump for debugging; escalate to the next candidate.
    }

    return { ok: false, error: lastError };
}

function parseModelOverride(modelId: string): HistorianModelOverride | null {
    const [providerID, ...modelParts] = modelId.split("/");
    const modelID = modelParts.join("/");
    if (!providerID || modelID.length === 0) {
        return null;
    }

    return { providerID, modelID };
}

function getHistorianRetryBackoffMs(retryIndex: number): number {
    if (retryIndex === 0) {
        return 2_000 + Math.floor(Math.random() * 1_001);
    }

    return 6_000 + Math.floor(Math.random() * 2_001);
}

function isTransientHistorianPromptError(message: string): boolean {
    const normalized = message.toLowerCase();
    if (
        normalized.includes("invalid request") ||
        normalized.includes("bad request") ||
        normalized.includes("unauthorized") ||
        normalized.includes("forbidden") ||
        normalized.includes("authentication") ||
        normalized.includes("auth") ||
        normalized.includes(" 400") ||
        normalized.startsWith("400")
    ) {
        return false;
    }

    return [
        "429",
        "rate limit",
        "timeout",
        "econnreset",
        "etimedout",
        "503",
        "502",
        "500",
        "overloaded",
    ].some((token) => normalized.includes(token));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function cleanupHistorianDump(sessionId: string, dumpPath?: string): void {
    if (!dumpPath) return;

    try {
        unlinkSync(dumpPath);
    } catch (error: unknown) {
        shared.sessionLog(
            sessionId,
            "compartment agent: failed to remove historian response dump",
            {
                dumpPath,
                error: getErrorMessage(error),
            },
        );
    }
}

function dumpHistorianResponse(
    sessionId: string,
    directory: string,
    label: string,
    text: string,
): string | undefined {
    try {
        const dumpDir = historianResponseDumpDir(directory);
        mkdirSync(dumpDir, { recursive: true });
        // Keep the transient dump dir out of the user's git status.
        ensureCortexKitArtifactGitignore(directory);
        const safeSessionId = sanitizeDumpName(sessionId);
        const safeLabel = sanitizeDumpName(label);
        const dumpPath = join(dumpDir, `${safeSessionId}-${safeLabel}-${Date.now()}.xml`);
        writeFileSync(dumpPath, text, "utf8");
        shared.sessionLog(sessionId, "compartment agent: historian response dumped", {
            label,
            dumpPath,
        });
        return dumpPath;
    } catch (error: unknown) {
        shared.sessionLog(sessionId, "compartment agent: failed to dump historian response", {
            label,
            error: getErrorMessage(error),
        });
        return undefined;
    }
}

function sanitizeDumpName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}
