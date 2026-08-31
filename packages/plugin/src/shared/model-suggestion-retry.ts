import type { createOpencodeClient } from "@opencode-ai/sdk";

import { detectOverflow } from "../features/magic-context/overflow-detection";
import { log } from "./logger";
import { parseProviderModel } from "./resolve-fallbacks";

type Client = ReturnType<typeof createOpencodeClient>;

/**
 * The 3-second limit prevents a wedged abort endpoint from masking the original timeout or abort error. */
const ABORT_CALL_TIMEOUT_MS = 3000;

export type PromptBody = {
    model?: { providerID: string; modelID: string };
    [key: string]: unknown;
};

export type PromptArgs = {
    path: { id: string };
    body: PromptBody;
    signal?: AbortSignal;
    [key: string]: unknown;
};

/**
 * Some prompt facades normalize or consume request bodies after failed attempts.
 * Fallback attempts must receive a fresh copy of the original request body.
 */
function copyPromptArgs(args: PromptArgs, body: PromptBody): PromptArgs {
    return { ...args, body: { ...body } };
}

export interface PromptAttemptInfo {
    /** `label` identifies the model in logs as `primary` or `provider/model`. */
    label: string;
    /** Zero-based attempt index: 0 is primary, 1+ are fallback models. */
    attemptIndex: number;
    /** `isFallback` is true for configured fallbacks and false for the primary attempt. */
    isFallback: boolean;
    /** `totalAttempts` includes the primary and every configured fallback. */
    totalAttempts: number;
    /** `model` overrides the model for this attempt when supplied. */
    model?: { providerID: string; modelID: string };
}

export interface PromptRetryOptions {
    timeoutMs?: number;
    /** External abort signal cancels the in-flight LLM prompt when aborted. */
    signal?: AbortSignal;
    /**
     * `fallbackModels` lists alternates to try after the primary attempt fails.
     * Empty or undefined `fallbackModels` disables fallback iteration.
     *
     * Fallback policy:
     *   - Each fallback gets the FULL `timeoutMs` budget (per-attempt, not total).
     * Each attempt runs its suggestion retry once.
     * Each attempt retries a `did you mean X?` error once.
     * Abort, timeout, and context-overflow errors stop fallback iteration.
     * The retry loop throws the last error after all attempts fail.
     */
    fallbackModels?: readonly string[];
    /**
     * `callContext` identifies the call site in structured logs.
     * Structured logs use `callContext` to correlate fallback attempts with a call site.
     * `callContext` defaults to `subagent`.
     */
    callContext?: string;
}

export interface ValidatedPromptRetryOptions<TOutput, TValidated> extends PromptRetryOptions {
    /**
     * OpenCode exposes results through session messages.
     * Each caller validates a different output shape.
     */
    fetchOutput: (args: PromptArgs, attempt: PromptAttemptInfo) => Promise<TOutput>;
    /**
     * A thrown validation error rejects the model output and advances to the next fallback.
     */
    validateOutput: (
        output: TOutput,
        attempt: PromptAttemptInfo,
    ) => TValidated | Promise<TValidated>;
}

export interface ValidatedPromptRetryResult<TOutput, TValidated> {
    output: TOutput;
    validated: TValidated;
    attempt: PromptAttemptInfo;
}

export interface ModelSuggestionInfo {
    providerID: string;
    modelID: string;
    suggestion: string;
}

function extractMessage(error: unknown): string {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
    if (typeof error === "object" && error !== null) {
        const obj = error as Record<string, unknown>;
        if (typeof obj.message === "string") return obj.message;
    }

    try {
        return JSON.stringify(error);
    } catch (_error) {
        return String(error);
    }
}

function parseModelSuggestion(error: unknown): ModelSuggestionInfo | null {
    if (!error) return null;

    if (typeof error === "object" && error !== null) {
        const errObj = error as Record<string, unknown>;

        if (
            errObj.name === "ProviderModelNotFoundError" &&
            typeof errObj.data === "object" &&
            errObj.data !== null
        ) {
            const data = errObj.data as Record<string, unknown>;
            const suggestions = data.suggestions;
            if (Array.isArray(suggestions) && typeof suggestions[0] === "string") {
                return {
                    providerID: String(data.providerID ?? ""),
                    modelID: String(data.modelID ?? ""),
                    suggestion: suggestions[0],
                };
            }
        }

        for (const key of ["data", "error", "cause"] as const) {
            const nested = errObj[key];
            if (nested && typeof nested === "object") {
                const result = parseModelSuggestion(nested);
                if (result) return result;
            }
        }
    }

    const message = extractMessage(error);
    const modelMatch = message.match(/model not found:\s*([^/\s]+)\s*\/\s*([^.,\s]+)/i);
    const suggestionMatch = message.match(/did you mean:\s*([^,?]+)/i);

    if (!modelMatch || !suggestionMatch) {
        return null;
    }

    return {
        providerID: modelMatch[1].trim(),
        modelID: modelMatch[2].trim(),
        suggestion: suggestionMatch[1].trim(),
    };
}

async function promptWithTimeout(
    client: Client,
    args: PromptArgs,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<void> {
    // The external-abort check prevents an upstream prompt call after external abort.
    if (signal?.aborted) {
        throw new Error("prompt aborted by external signal");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort);

    try {
        await client.session.prompt({
            ...args,
            signal: controller.signal,
        } as Parameters<typeof client.session.prompt>[0]);
    } catch (error) {
        if (signal?.aborted) {
            // External abort cancels only the client fetch; abort the child session.
            await abortChildRun(client, args.path.id);
            throw new Error("prompt aborted by external signal");
        }
        if (controller.signal.aborted) {
            // A timeout aborts only the client fetch; abort the child session.
            await abortChildRun(client, args.path.id);
            throw new Error(`prompt timed out after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onExternalAbort);
    }
}

/**
 * The child session continues running after a prompt timeout or external abort.
 * An abort-session failure must not mask the original timeout or abort error.
 */
async function abortChildRun(client: Client, sessionId: string): Promise<void> {
    try {
        // The 3-second cleanup timeout prevents cleanup from delaying the original timeout or abort error.
        await Promise.race([
            client.session.abort({ path: { id: sessionId } }),
            new Promise<void>((resolve) => setTimeout(resolve, ABORT_CALL_TIMEOUT_MS)),
        ]);
    } catch (error) {
        log(`[model-retry] child session abort failed for ${sessionId}: ${String(error)}`);
    }
}

/**
 *
 * A timeout stops fallback iteration.
 *
 * Other errors remain eligible for fallback retries.
 * different model.
 */
function isNonRetryable(error: unknown, externalSignal?: AbortSignal): boolean {
    if (externalSignal?.aborted) return true;

    if (error instanceof Error) {
        if (error.name === "AbortError") return true;
        // `promptWithTimeout` wraps external aborts and timeouts in `Error` messages.
        // recognizable message.
        if (error.message === "prompt aborted by external signal") return true;
        if (/^prompt timed out after \d+ms$/.test(error.message)) return true;
    }

    if (detectOverflow(error).isOverflow) return true;

    return false;
}

function shortErr(error: unknown): string {
    if (error instanceof Error) {
        return error.name && error.name !== "Error"
            ? `${error.name}: ${error.message}`
            : error.message;
    }
    return extractMessage(error);
}

/**
 * The function retries once when the SDK suggests a replacement model.
 */
async function attemptOnce(
    client: Client,
    args: PromptArgs,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    callContext: string,
    label: string,
): Promise<void> {
    // Failed prompt facades may rewrite request bodies before rejecting, so `originalBody` remains separate.
    // `originalBody.model` identifies the model that the suggested retry replaces.
    const originalBody = { ...args.body };
    const attemptArgs = copyPromptArgs(args, originalBody);
    try {
        await promptWithTimeout(client, attemptArgs, timeoutMs, signal);
        return;
    } catch (error) {
        if (isNonRetryable(error, signal)) throw error;

        const suggestion = parseModelSuggestion(error);
        if (!suggestion || !originalBody.model) {
            // The caller's fallback loop selects the next model when no suggested model is available.
            throw error;
        }

        log(`[${callContext}] ${label}: model not found, retrying with suggestion`, {
            original: `${suggestion.providerID}/${suggestion.modelID}`,
            suggested: suggestion.suggestion,
        });

        await promptWithTimeout(
            client,
            copyPromptArgs(args, {
                ...originalBody,
                model: {
                    providerID: suggestion.providerID,
                    modelID: suggestion.suggestion,
                },
            }),
            timeoutMs,
            signal,
        );
    }
}

/**
 *
 * The function tries the resolved primary model before `options.fallbackModels`.
 * Each attempt retries once when the SDK suggests a replacement model.
 * `isNonRetryable` errors stop fallback retries.
 *
 * With no fallback models, only the model-suggestion retry runs.
 */
export async function promptSyncWithModelSuggestionRetry(
    client: Client,
    args: PromptArgs,
    options: PromptRetryOptions = {},
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const callContext = options.callContext ?? "subagent";
    const fallbacks = options.fallbackModels ?? [];
    // Fallbacks must not inherit request-body mutations from failed requests.
    const baseBody = { ...args.body };
    const baseArgs = copyPromptArgs(args, baseBody);

    const explicitPrimaryLabel =
        baseBody.model?.providerID && baseBody.model.modelID
            ? `${baseBody.model.providerID}/${baseBody.model.modelID}`
            : "primary";

    let lastError: unknown = null;

    try {
        await attemptOnce(
            client,
            baseArgs,
            timeoutMs,
            options.signal,
            callContext,
            explicitPrimaryLabel,
        );
        return;
    } catch (error) {
        lastError = error;
        if (isNonRetryable(error, options.signal)) throw error;

        if (fallbacks.length === 0) {
            throw error;
        }

        log(
            `[${callContext}] primary (${explicitPrimaryLabel}) failed: ${shortErr(error)}; trying ${fallbacks.length} fallback(s)`,
        );
    }

    // Iterate fallbacks.
    for (let i = 0; i < fallbacks.length; i += 1) {
        const parsed = parseProviderModel(fallbacks[i]);
        if (!parsed) {
            log(`[${callContext}] skipping invalid fallback spec: ${fallbacks[i]}`);
            continue;
        }

        const label = `${parsed.providerID}/${parsed.modelID}`;
        const attemptArgs = copyPromptArgs(baseArgs, {
            ...baseBody,
            model: parsed,
        });

        try {
            await attemptOnce(client, attemptArgs, timeoutMs, options.signal, callContext, label);
            log(
                `[${callContext}] fallback succeeded with ${label} (attempt ${i + 2}/${fallbacks.length + 1})`,
            );
            return;
        } catch (error) {
            lastError = error;
            if (isNonRetryable(error, options.signal)) throw error;

            const remaining = fallbacks.length - i - 1;
            if (remaining > 0) {
                log(
                    `[${callContext}] ${label} failed: ${shortErr(error)}; ${remaining} fallback(s) left`,
                );
            }
        }
    }

    // diagnostic.
    log(
        `[${callContext}] all models exhausted; tried: ${[explicitPrimaryLabel, ...fallbacks].join(", ")}; last error: ${shortErr(lastError)}`,
    );
    throw lastError ?? new Error("All fallback models failed");
}

async function attemptAndValidate<TOutput, TValidated>(
    client: Client,
    args: PromptArgs,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    callContext: string,
    attempt: PromptAttemptInfo,
    options: ValidatedPromptRetryOptions<TOutput, TValidated>,
): Promise<ValidatedPromptRetryResult<TOutput, TValidated>> {
    await attemptOnce(client, args, timeoutMs, signal, callContext, attempt.label);
    const output = await options.fetchOutput(args, attempt);
    const validated = await options.validateOutput(output, attempt);
    return { output, validated, attempt };
}

/**
 *
 */
export async function promptSyncWithValidatedOutputRetry<TOutput, TValidated = TOutput>(
    client: Client,
    args: PromptArgs,
    options: ValidatedPromptRetryOptions<TOutput, TValidated>,
): Promise<ValidatedPromptRetryResult<TOutput, TValidated>> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const callContext = options.callContext ?? "subagent";
    const fallbacks = options.fallbackModels ?? [];
    const baseBody = { ...args.body };
    const baseArgs = copyPromptArgs(args, baseBody);

    const explicitPrimaryLabel =
        baseBody.model?.providerID && baseBody.model.modelID
            ? `${baseBody.model.providerID}/${baseBody.model.modelID}`
            : "primary";
    const totalAttempts = fallbacks.length + 1;

    let firstError: unknown = null;
    let lastError: unknown = null;

    try {
        return await attemptAndValidate(
            client,
            baseArgs,
            timeoutMs,
            options.signal,
            callContext,
            {
                label: explicitPrimaryLabel,
                attemptIndex: 0,
                isFallback: false,
                totalAttempts,
                model: baseBody.model,
            },
            options,
        );
    } catch (error) {
        firstError = error;
        lastError = error;
        if (isNonRetryable(error, options.signal)) throw error;

        if (fallbacks.length === 0) {
            throw error;
        }

        log(
            `[${callContext}] primary (${explicitPrimaryLabel}) failed validation/prompt: ${shortErr(error)}; trying ${fallbacks.length} fallback(s)`,
        );
    }

    for (let i = 0; i < fallbacks.length; i += 1) {
        const parsed = parseProviderModel(fallbacks[i]);
        if (!parsed) {
            log(`[${callContext}] skipping invalid fallback spec: ${fallbacks[i]}`);
            continue;
        }

        const label = `${parsed.providerID}/${parsed.modelID}`;
        const attemptArgs = copyPromptArgs(baseArgs, {
            ...baseBody,
            model: parsed,
        });
        const attempt: PromptAttemptInfo = {
            label,
            attemptIndex: i + 1,
            isFallback: true,
            totalAttempts,
            model: parsed,
        };

        try {
            const result = await attemptAndValidate(
                client,
                attemptArgs,
                timeoutMs,
                options.signal,
                callContext,
                attempt,
                options,
            );
            log(
                `[${callContext}] fallback succeeded with ${label} (attempt ${i + 2}/${fallbacks.length + 1})`,
            );
            return result;
        } catch (error) {
            if (firstError === null) firstError = error;
            lastError = error;
            if (isNonRetryable(error, options.signal)) throw error;

            const remaining = fallbacks.length - i - 1;
            if (remaining > 0) {
                log(
                    `[${callContext}] ${label} failed validation/prompt: ${shortErr(error)}; ${remaining} fallback(s) left`,
                );
            }
        }
    }

    log(
        `[${callContext}] all models exhausted; tried: ${[explicitPrimaryLabel, ...fallbacks].join(", ")}; original error: ${shortErr(firstError)}; last error: ${shortErr(lastError)}`,
    );
    throw firstError ?? lastError ?? new Error("All fallback models failed validation");
}
