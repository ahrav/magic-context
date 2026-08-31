/**
 * This module defines cross-bundle error shapes for mc-host consumers.
 *
 * Consumers recognize `McHostCallError` structurally because bundled copies fail `instanceof`.
 * `name` and `kind` identify cross-bundle errors; `code`, when present, must be a string.
 *
 * This module must not import connection or facade code.
 */

const CALL_ERROR_KINDS: readonly string[] = ["not_sent", "outcome_unknown", "terminal"];

/**
 */
export const DAEMON_GENERATION_CHANGED_CODE = "daemon_generation_changed";

/**
 * rejected.
 */
export function isMcHostCallError(error: unknown): error is McHostCallError {
    if (error instanceof McHostCallError) return true;
    if (!(error instanceof Error) || error.name !== "McHostCallError") return false;
    const { kind, code } = error as { kind?: unknown; code?: unknown };
    if (typeof kind !== "string" || !CALL_ERROR_KINDS.includes(kind)) return false;
    return code === undefined || typeof code === "string";
}

/**
 * `McHostCallErrorKind` defines send-outcome classifications.
 *
 */
export type McHostCallErrorKind = "not_sent" | "outcome_unknown" | "terminal";

/* */
export class McHostCallError extends Error {
    /* */
    cleanup?: Promise<void>;

    /**
     */
    errorTerminal?: { bodyText: string | null; flags: number; streamed: boolean };

    /* */
    retry_after_ms?: number;

    constructor(
        readonly kind: McHostCallErrorKind,
        message: string,
        readonly code?: string,
        readonly cause?: unknown,
    ) {
        super(message);
        this.name = "McHostCallError";
    }
}

export class McHostClientError extends Error {
    constructor(
        message: string,
        readonly code?: string,
    ) {
        super(message);
        this.name = "McHostClientError";
    }
}

export class SocketClosedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SocketClosedError";
    }
}

export class SocketTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SocketTimeoutError";
    }
}
