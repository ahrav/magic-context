/**
 *
 * material:
 *
 *     post-overflow limit.
 *
 * `event-handler.ts` does:
 *
 *
 */

interface PiAssistantUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}

export interface PiPressure {
	/** `inputTokens` counts tokens charged against `contextLimit`. */
	inputTokens: number;
	/** `percentage` is `inputTokens / contextLimit * 100`, or `0` when `contextLimit <= 0`. */
	percentage: number;
}

/**
 */
export function extractAssistantUsage(
	message: unknown,
): PiAssistantUsage | null {
	if (!message || typeof message !== "object") return null;
	const m = message as { role?: unknown; usage?: unknown };
	if (m.role !== "assistant") return null;
	if (!m.usage || typeof m.usage !== "object") return null;
	const u = m.usage as Record<string, unknown>;
	const result: PiAssistantUsage = {};
	if (typeof u.input === "number") result.input = u.input;
	if (typeof u.output === "number") result.output = u.output;
	if (typeof u.cacheRead === "number") result.cacheRead = u.cacheRead;
	if (typeof u.cacheWrite === "number") result.cacheWrite = u.cacheWrite;
	if (typeof u.totalTokens === "number") result.totalTokens = u.totalTokens;
	return result;
}

/**
 *
 * `packages/plugin/src/hooks/magic-context/event-handler.ts:388-397`
 * exactly:
 *
 */
export function computePiPressure(
	usage: PiAssistantUsage | null,
	contextLimit: number,
): PiPressure | null {
	if (!usage) return null;
	const input = usage.input ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const inputTokens = input + cacheRead + cacheWrite;
	if (inputTokens === 0) return null;
	const percentage = contextLimit > 0 ? (inputTokens / contextLimit) * 100 : 0;
	return { inputTokens, percentage };
}
