import type { createOpencodeClient } from "@opencode-ai/sdk";

import { detectOverflow } from "../features/magic-context/overflow-detection";
import { log } from "./logger";
import { parseProviderModel } from "./resolve-fallbacks";

type Client = ReturnType<typeof createOpencodeClient>;

/** Max time to wait for the best-effort child-session abort HTTP call before
 *  giving up on its response (the abort still proceeds server-side). Keeps a
 *  wedged abort endpoint from masking the original timeout/abort error. */
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
 * Keep a prompt body independent from SDK/client mutation. Some prompt facades
 * normalize or consume request bodies while handling a failed attempt; fallback
 * attempts must start from the original system prompt and request body every time.
 */
function copyPromptArgs(args: PromptArgs, body: PromptBody): PromptArgs {
    return { ...args, body: { ...body } };
}

export interface PromptAttemptInfo {
    /** Human-readable model label used in logs ("primary" or "provider/model"). */
    label: string;
    /** Zero-based attempt index: 0 is primary, 1+ are fallback models. */
    attemptIndex: number;
    /** True for configured fallback models, false for the primary attempt. */
    isFallback: boolean;
    /** Total attempted models including the primary and all configured fallbacks. */
    totalAttempts: number;
    /** Explicit model override for this attempt, when one was supplied. */
    model?: { providerID: string; modelID: string };
}

export interface PromptRetryOptions {
    timeoutMs?: number;
    /** External abort signal — cancels the in-flight LLM prompt immediately when aborted */
    signal?: AbortSignal;
    /**
     * Ordered list of "provider/modelID" alternates to try if the primary call
     * (and its single-suggestion retry) fails. Empty / undefined = no fallback
     * iteration (legacy behavior).
     *
     * Fallback policy:
     *   - Each fallback gets the FULL `timeoutMs` budget (per-attempt, not total).
     *   - Suggestion-retry runs inside each attempt (so "did you mean X?" errors
     *     still self-heal at the primary AND at each fallback).
     *   - Iteration stops immediately on abort/timeout/context-overflow errors —
     *     fallbacks won't help and the caller's emergency-recovery path needs
     *     to handle these.
     *   - On all-failed, the LAST error is thrown (matches legacy behavior when
     *     `fallbackModels` is empty).
     */
    fallbackModels?: readonly string[];
    /**
     * Identifier for structured logging (e.g. "dreamer:consolidate",
     * "historian", "compressor", "sidekick"). Helps correlate fallback
     * attempts to a specific call site in `magic-context.log`. Defaults to
     * "subagent" if not provided.
     */
    callContext?: string;
}

export interface ValidatedPromptRetryOptions<TOutput, TValidated> extends PromptRetryOptions {
    /**
     * Fetch the output produced by the just-completed prompt attempt. This is
     * intentionally caller-owned because OpenCode exposes results via session
     * messages and each caller validates a different shape.
     */
    fetchOutput: (args: PromptArgs, attempt: PromptAttemptInfo) => Promise<TOutput>;
    /**
     * Validate and optionally transform the fetched output. Throw to reject this
     * model's output and advance to the next configured fallback model.
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
    // Bail immediately if the caller's signal is already aborted (e.g.
    // lease loss before this attempt was scheduled). Per spec
    // `addEventListener('abort', ...)` on an already-aborted signal fires
    // synchronously in modern Node/Bun, but an explicit guard is clearer
    // and avoids one wasted upstream `client.session.prompt` round-trip
    // before `isNonRetryable` catches the cancellation at the chain loop.
    if (signal?.aborted) {
        throw new Error("prompt aborted by external signal");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // Link external signal to internal controller so external abort cancels the fetch
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort);

    try {
        await client.session.prompt({
            ...args,
            signal: controller.signal,
        } as Parameters<typeof client.session.prompt>[0]);
    } catch (error) {
        if (signal?.aborted) {
            // External abort (e.g. dreamer lease loss): the child run loop is an
            // independent SERVER-SIDE fiber — cancelling our client fetch alone
            // leaves it looping the LLM forever (issue #154). Force-stop it.
            await abortChildRun(client, args.path.id);
            throw new Error("prompt aborted by external signal");
        }
        if (controller.signal.aborted) {
            // Our timeout fired. Same problem: abort the server-side run loop, not
            // just our fetch, or the child keeps re-calling the LLM past the
            // timeout (uncancellable by the user's ESC — issue #154).
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
 * Force-stop a spawned child session's server-side run loop. `controller.abort()`
 * on the prompt signal only cancels OUR client fetch; the run loop is a separate
 * instance-scoped fiber that `POST /session/{id}/abort` interrupts. Best-effort —
 * a failure here must not mask the original timeout/abort error.
 */
async function abortChildRun(client: Client, sessionId: string): Promise<void> {
    try {
        // Bound the abort call: it's best-effort cleanup, and if the abort
        // endpoint itself stalls (the runner is wedged) an unbounded await here
        // would hang the caller and MASK the original timeout/abort error that we
        // still need to surface. Race against a short timer; the abort keeps
        // running server-side regardless of whether we wait for its response.
        await Promise.race([
            client.session.abort({ path: { id: sessionId } }),
            new Promise<void>((resolve) => setTimeout(resolve, ABORT_CALL_TIMEOUT_MS)),
        ]);
    } catch (error) {
        log(`[model-retry] child session abort failed for ${sessionId}: ${String(error)}`);
    }
}

/**
 * Returns true if the error indicates a NON-RETRYABLE condition where iterating
 * to a fallback model would be pointless or harmful:
 *
 *   - External abort (user cancellation, lease loss, etc.) — caller wants to
 *     stop, not retry.
 *   - Context overflow — same prompt will overflow on any reasonably-sized
 *     model. Caller has its own emergency-recovery path for this.
 *   - Timeout — same wall-clock budget on the same prompt is unlikely to
 *     succeed on another model. Caller decides whether to retry at a higher
 *     level (e.g. historian's MAX_HISTORIAN_RETRIES loop).
 *
 * Everything else (auth errors, ProviderModelNotFoundError without suggestion,
 * rate limits, transient network failures, etc.) is considered retryable on a
 * different model.
 */
function isNonRetryable(error: unknown, externalSignal?: AbortSignal): boolean {
    if (externalSignal?.aborted) return true;

    if (error instanceof Error) {
        if (error.name === "AbortError") return true;
        // promptWithTimeout wraps both abort cases in plain `Error` with a
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
 * Try a single prompt attempt against the supplied body, with the existing
 * single-suggestion retry layered inside (so "did you mean X?" still self-heals
 * per attempt). Throws on failure; returns on success.
 */
async function attemptOnce(
    client: Client,
    args: PromptArgs,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    callContext: string,
    label: string,
): Promise<void> {
    // Keep this snapshot separate from the object passed to the client. A
    // failed prompt facade may rewrite its request body before rejecting; the
    // model-suggestion retry still needs the original system prompt.
    const originalBody = { ...args.body };
    const attemptArgs = copyPromptArgs(args, originalBody);
    try {
        await promptWithTimeout(client, attemptArgs, timeoutMs, signal);
        return;
    } catch (error) {
        // If non-retryable (abort, overflow, timeout), bubble up immediately.
        // Don't even try suggestion retry — caller needs the original error.
        if (isNonRetryable(error, signal)) throw error;

        const suggestion = parseModelSuggestion(error);
        if (!suggestion || !originalBody.model) {
            // No suggestion available — caller's fallback loop will decide
            // whether to try the next chain entry.
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
 * Run an OpenCode subagent prompt with model fallback support.
 *
 * Attempts the configured primary model first (whatever `args.body.model` or
 * the registered agent default resolves to), then iterates through
 * `options.fallbackModels` if provided. Each attempt internally retries once on
 * the SDK's "model not found, did you mean X?" suggestion. Aborts, timeouts,
 * and context-overflow errors short-circuit the fallback loop because retrying
 * the same prompt against another model won't help.
 *
 * Behavior with `fallbackModels` empty/undefined is identical to the pre-v0.18
 * single-suggestion retry — fully backward-compatible for callers that haven't
 * been updated to thread a chain.
 */
export async function promptSyncWithModelSuggestionRetry(
    client: Client,
    args: PromptArgs,
    options: PromptRetryOptions = {},
): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const callContext = options.callContext ?? "subagent";
    const fallbacks = options.fallbackModels ?? [];
    // Snapshot the body before the first client call. The Pi facade and the
    // OpenCode SDK both receive this same shape, and either may mutate it while
    // handling a failed request. Fallbacks must never inherit that mutation.
    const baseBody = { ...args.body };
    const baseArgs = copyPromptArgs(args, baseBody);

    // Attempt 0 = whatever the agent or explicit body.model resolves to.
    // Subsequent attempts override body.model with each fallback in order.
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
            // No fallbacks configured — behave exactly like legacy: propagate
            // the original error (which may already have had its suggestion
            // retry attempted inside `attemptOnce`).
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

    // All exhausted. Log the full chain and throw the last error so the
    // caller's report (e.g. /ctx-dream tasks_json) still surfaces a real
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
 * Run a prompt with model fallback support, but accept an attempt only after the
 * caller validates the model's actual output. This covers "empty success" cases
 * where the provider/OpenCode prompt call completes successfully but the subagent
 * produced no usable assistant text / JSON.
 *
 * The happy path is still one prompt + one caller-owned output fetch: callers
 * should use the returned output instead of fetching messages a second time.
 * Validation failures are retryable across configured fallback models. If every
 * attempt produces invalid output (or otherwise fails retryably), the first
 * failure is re-thrown so callers surface the original failure semantics.
 */
export async function promptSyncWithValidatedOutputRetry<TOutput, TValidated = TOutput>(
    client: Client,
    args: PromptArgs,
    options: ValidatedPromptRetryOptions<TOutput, TValidated>,
): Promise<ValidatedPromptRetryResult<TOutput, TValidated>> {
    const timeoutMs = options.timeoutMs ?? 300_000;
    const callContext = options.callContext ?? "subagent";
    const fallbacks = options.fallbackModels ?? [];
    // Snapshot the body before the first client call. The Pi facade and the
    // OpenCode SDK both receive this same shape, and either may mutate it while
    // handling a failed request. Fallbacks must never inherit that mutation.
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
