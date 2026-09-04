export declare function isDefaultSessionTitle(title: string): boolean;
export interface SafeTargetOptions {
    /** Total title checks before giving up (default 4). */
    attempts?: number;
    /** Delay between checks in ms (default 15s). */
    delayMs?: number;
}
/**
 * Resolve whether `sessionId` is safe to receive an ignored-message post.
 *
 * - "safe": the session has a real (non-default) title, or the title is
 *   unreadable (fail-open).
 * - "skip": the session still has OpenCode's default title after all
 *   attempts — posting now could permanently suppress its title generation.
 *   The caller must leave its delivered/seen marker unset so a later
 *   startup retries.
 *
 * The retry window exists for the common startup case: plugin init fires a
 * few seconds after launch, the user prompts shortly after, and the title
 * lands within seconds of that first prompt.
 */
export declare function waitForSafeNotificationTarget(client: unknown, sessionId: string, options?: SafeTargetOptions): Promise<"safe" | "skip">;
//# sourceMappingURL=safe-notification-target.d.ts.map