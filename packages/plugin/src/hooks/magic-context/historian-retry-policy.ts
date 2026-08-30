/**
 * Historian prompt retry policy shared by the OpenCode and Pi runners: a
 * retry decision that must agree across harnesses, kept in one module so a
 * provider error string added for one host cannot silently change retry
 * behavior on only the other.
 */

export const MAX_HISTORIAN_RETRIES = 2;

export function getHistorianRetryBackoffMs(retryIndex: number): number {
    if (retryIndex === 0) {
        return 2_000 + Math.floor(Math.random() * 1_001);
    }

    return 6_000 + Math.floor(Math.random() * 2_001);
}

export function isTransientHistorianPromptError(message: string): boolean {
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
