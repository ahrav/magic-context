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
 *
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
     * `runValidatedHistorianPass` tries `provider/modelID` fallback entries in order after the primary historian model fails.
     * `fallbackModels` is independent of `fallbackModelId`, which retries the active session model.
     */
    fallbackModels?: readonly string[];
    callbacks?: HistorianProgressCallbacks;
    responseDumpObserver?: (dumpPath: string) => void;
    /** When true, `twoPass` runs a second editor pass after successful historian output.
     * The editor pass targets low-signal `U:` lines and cross-compartment duplicates.
     * If editor validation fails, the pass returns the first-pass draft. */
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
        // Cleanup retains `firstRun.dumpPath` after an initial failure for debugging.
        // Cleanup deletes only the successful repair run's dump.
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
 * The editor returns its validated result on success and otherwise returns the draft.
 * The editor never replaces a validated draft with an invalid result.
 *
 * The editor pass does not receive `fallbackModels`.
 * If the editor model fails, the pass returns the validated draft.
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
        // On editor failure, the pass retains the validated draft.
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
        // The pass retains the editor dump when editor validation fails.
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
    /** `agentId` routes the request to the selected agent and defaults to `HISTORIAN_AGENT`.
     * */
    agentId?: string;
    /* */
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
    // The historian retains failed child sessions so their model output, exact prompt, and error remain inspectable.
    // The cleanup deletes successful child sessions because their results are persisted as compartments.
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
                            // `agentId` selects the registered agent whose system prompt OpenCode loads.
                            // When `modelOverride` is set, OpenCode uses that model while retaining the selected agent's registered system prompt.
                            agent: agentId,
                            ...(modelOverride ? { model: modelOverride } : {}),
                            // `synthetic: true` prevents OpenCode from rendering the internal prompt in the TUI subagent pane.
                            // The prompt would otherwise render as a large visible message in the OpenCode TUI.
                            // The model receives synthetic messages because `toModelMessages` filters only `ignored` messages.
                            parts: [{ type: "text", text: prompt, synthetic: true }],
                        },
                    },
                    {
                        timeoutMs: timeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS,
                        // `modelOverride` disables `fallbackModels` because the fallback candidates have already been tried.
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
                // Observer failures after a valid dump must not discard the historian result or trigger fallback.
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
        // The historian retains failed child sessions so their output, prompt, and error remain inspectable; it deletes successful sessions because their result is persisted as a compartment.
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
     * The fallback runner tries configured models in order before the session-model last resort; invalid, empty, or unparseable output advances to the next candidate.
     */
    fallbackModels?: readonly string[];
    /**
     */
    fallbackModelId?: string;
    callbacks?: HistorianProgressCallbacks;
    agentId?: string;
    responseDumpObserver?: (dumpPath: string) => void;
    error: string;
    dumpPaths: Array<string | undefined>;
}): Promise<ValidatedHistorianPassResult> {
    // Empty successful responses advance to the next candidate.
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
            // The function cleans up only the successful fallbackRun.dumpPath; failed-run dumps remain for debugging.
            cleanupHistorianDump(args.parentSessionId, fallbackRun.dumpPath);
            return { ...fallbackValidation, invocationId: fallbackRun.invocationId ?? null };
        }
        lastError = fallbackValidation.error ?? lastError;
        // A validation failure retains fallbackRun.dumpPath for debugging before the next candidate runs.
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
