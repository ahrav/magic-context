/**
 * Cross-bundle error shapes for the mc-host consumer client.
 *
 * Consumers recognize these by wire-visible shape (`name`, `code`, `kind`,
 * `message`) rather than `instanceof`, because a plugin bundle can carry a
 * different copy of the client than the code that threw. Every name, code,
 * and kind value here must therefore stay recognizable across bundled copies.
 *
 * Leaf module: no imports from connection or facade code.
 */

const CALL_ERROR_KINDS: readonly string[] = ["not_sent", "outcome_unknown", "terminal"];

/**
 * Stable wire code: the authenticated daemon no longer matches the
 * lifecycle-validated incarnation the caller bound to. The facade produces
 * it and consumers (transport reconnect classification, Synapse restart
 * classification) recognize daemon rotation by this exact string, so every
 * producer and consumer must reference this one constant.
 */
export const DAEMON_GENERATION_CHANGED_CODE = "daemon_generation_changed";

/**
 * Cross-bundle recognition of {@link McHostCallError}. A different bundled
 * copy of this class fails `instanceof`, so recognition is structural; old
 * runtime names (the previous `Subc`-prefixed spellings) are deliberately
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
 * Send-outcome classification for a managed call failure.
 *
 * - `not_sent`: the request bytes provably never reached `socket.write()`.
 *   Policy may issue one fresh RPC.
 * - `outcome_unknown`: a frame may have been published and no matching
 *   terminal was observed. Never safe to replay generically.
 * - `terminal`: a matching terminal Error (or non-retryable setup failure)
 *   was observed; it applies only to that correlation.
 */
export type McHostCallErrorKind = "not_sent" | "outcome_unknown" | "terminal";

/** Managed call failure carrying send-outcome semantics. */
export class McHostCallError extends Error {
    /** The facade attaches `cleanup` when a caller abort produces this error. */
    cleanup?: Promise<void>;

    /** Host-advised delay before retrying this operation. */
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
