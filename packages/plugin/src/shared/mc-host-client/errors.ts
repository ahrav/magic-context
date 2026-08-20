/**
 * Cross-bundle error shapes for the mc-host consumer client.
 *
 * Consumers recognize these by wire-visible shape (`name`, `code`, `kind`,
 * `message`) rather than `instanceof`, because a plugin bundle can carry a
 * different copy of the client than the code that threw. Every name, code,
 * and kind value here must therefore stay recognizable across bundled copies
 * (plan R3).
 *
 * Leaf module: no imports from connection or facade code.
 */

/**
 * Send-outcome classification for a managed call failure.
 *
 * - `not_sent`: the request bytes provably never reached `socket.write()`.
 *   Policy may issue one fresh RPC.
 * - `outcome_unknown`: any byte may have reached the socket and no matching
 *   terminal was observed. Never safe to replay generically.
 * - `terminal`: a matching terminal Error (or non-retryable setup failure)
 *   was observed; it applies only to that correlation.
 */
export type SubcCallErrorKind = "not_sent" | "outcome_unknown" | "terminal";

/** Managed call failure carrying send-outcome semantics. */
export class SubcCallError extends Error {
    /** The facade attaches `cleanup` when a caller abort produces this error. */
    cleanup?: Promise<void>;

    constructor(
        readonly kind: SubcCallErrorKind,
        message: string,
        readonly code?: string,
        readonly cause?: unknown,
    ) {
        super(message);
        this.name = "SubcCallError";
    }
}

export class SubcError extends Error {
    constructor(
        message: string,
        readonly code?: string,
    ) {
        super(message);
        this.name = "SubcError";
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
