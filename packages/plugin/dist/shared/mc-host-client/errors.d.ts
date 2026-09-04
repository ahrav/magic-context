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
/**
 * Cross-bundle recognition of {@link McHostCallError}. A different bundled
 * copy of this class fails `instanceof`, so recognition is structural; old
 * runtime names (the previous `Subc`-prefixed spellings) are deliberately
 * rejected.
 */
export declare function isMcHostCallError(error: unknown): error is McHostCallError;
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
export type McHostCallErrorKind = "not_sent" | "outcome_unknown" | "terminal";
/** Managed call failure carrying send-outcome semantics. */
export declare class McHostCallError extends Error {
    readonly kind: McHostCallErrorKind;
    readonly code?: string | undefined;
    readonly cause?: unknown | undefined;
    /** The facade attaches `cleanup` when a caller abort produces this error. */
    cleanup?: Promise<void>;
    /**
     * Captured only during transport negotiation, which replaces
     * peer-controlled Error terminals with a bounded failure before
     * exposing them to callers.
     */
    errorTerminal?: {
        bodyText: string | null;
        flags: number;
        streamed: boolean;
    };
    /** Host-advised delay before retrying this operation. */
    retry_after_ms?: number;
    constructor(kind: McHostCallErrorKind, message: string, code?: string | undefined, cause?: unknown | undefined);
}
export declare class McHostClientError extends Error {
    readonly code?: string | undefined;
    constructor(message: string, code?: string | undefined);
}
export declare class SocketClosedError extends Error {
    constructor(message: string);
}
export declare class SocketTimeoutError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map