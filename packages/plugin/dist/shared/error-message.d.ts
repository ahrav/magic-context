export declare function getErrorMessage(error: unknown): string;
/**
 * Produce a rich, safe-to-log description of any thrown value.
 *
 * Motivated by SDK errors whose `.message` is empty while `.name`/`toString()`
 * carry the actual signal (e.g. `NotFoundError` with no message on OpenCode
 * session-delete races). Using {@link getErrorMessage} alone erases that signal.
 *
 * Captures:
 * - `name` from the Error (defaults to `constructor.name`)
 * - `message` (may be empty)
 * - first few stack frames
 * - `String(error)` so objects and custom toString surfaces are visible
 * - Common HTTP-shape fields (`status`, `statusCode`, `code`)
 * - `cause` chain summary (first level only)
 *
 * Returns a compact, single-line-friendly string suitable for log lines,
 * plus a structured object for callers that want individual fields.
 */
export interface ErrorDescription {
    name: string;
    message: string;
    status?: string;
    code?: string;
    causeName?: string;
    stackHead?: string;
    stringForm: string;
    /** Best short summary for human-readable logs. Never empty. */
    brief: string;
}
export declare function describeError(error: unknown): ErrorDescription;
//# sourceMappingURL=error-message.d.ts.map