import { type FailClosedController } from "../features/magic-context/fail-closed-block";
type MessageWithParts = {
    info: import("@opencode-ai/sdk").Message;
    parts: import("@opencode-ai/sdk").Part[];
};
type MessagesTransformOutput = {
    messages: MessageWithParts[];
};
type MagicContextTransformHooks = {
    "experimental.chat.messages.transform"?: (input: Record<string, never>, output: MessagesTransformOutput) => Promise<void>;
} | null;
/**
 * Top-level transform wrapper. Catches errors so OpenCode's prompt loop
 * always proceeds — without this guard, a transient DB contention event can
 * crash the user's turn through OpenCode's Effect pipeline. See issue #23:
 * https://github.com/cortexkit/magic-context/issues/23
 *
 * Error handling is tiered:
 *
 * - **FailClosedBlockingError / EmergencyFailClosedError / RawFallbackContextLimitError**:
 *   Intentional loud aborts. Rethrown so the TUI surfaces the message and the turn does not
 *   silently fall through to native compaction or a provider-rejected raw prompt.
 *
 * - **SQLITE_BUSY**: Transient, expected from concurrent plugin processes
 *   (second OpenCode instance, long dreamer/historian child session, slow
 *   WAL checkpoint). Logged tersely; next pass will retry naturally. No
 *   persistent telemetry needed.
 *
 * - **Non-BUSY errors**: Schema corruption, programming bugs, type errors.
 *   These can silently disable magic-context for the entire session if the
 *   error repeats on every pass. We:
 *     1. Log with full detail (code, name, message, stack).
 *     2. Persist a short error summary into `session_meta.last_transform_error`
 *        so the sidebar/dashboard surfaces the failure state. The sidebar
 *        already reads this field; runPostTransformPhase's catch only fires
 *        for errors that reach it, and an error thrown early enough bypasses
 *        it entirely. Writing it here at the outer boundary guarantees
 *        observability.
 *     3. Return with messages unmodified for this pass.
 *
 * Ordinary transform failures are not rethrown because OpenCode's Effect pipeline
 * turns thrown errors into user-visible prompt failures. FailClosedBlockingError,
 * EmergencyFailClosedError, and RawFallbackContextLimitError are intentional exceptions.
 * We accept degraded behavior (no injection / no drops this turn) rather than
 * blocking the user for ordinary bugs — but deterministic inoperability must
 * block loudly when fail_closed_blocking is on.
 *
 * Correctness is preserved because all persistent state mutations inside
 * the inner transform are idempotent across passes.
 */
export declare function createMessagesTransformHandler(args: {
    magicContext: MagicContextTransformHooks;
    /**
     * Optional live getter so a healed storage reopen can swap in real hooks
     * without rebuilding the outer wrapper.
     */
    getMagicContext?: () => MagicContextTransformHooks;
    failClosed?: FailClosedController | null;
    failClosedBlockingEnabled?: boolean;
    /**
     * Compaction-off mode (issue #266): the fail-closed BLOCKING wrapper is
     * inert BY DESIGN — MC inoperability no longer risks unbounded growth
     * because native compaction (or nothing) owns the window. A thrown or
     * failed transform degrades to passthrough of the input messages: no
     * blocking message, no cancelled request, one diagnostic. The enforce
     * call still runs (its re-probe can heal storage mid-process), but any
     * error it raises is converted to passthrough here.
     */
    compactionOff?: boolean;
    internalChildSessions?: Set<string>;
    tryReopenStorage?: () => boolean | Promise<boolean>;
}): (input: Record<string, never>, output: MessagesTransformOutput) => Promise<MessageWithParts[]>;
export {};
//# sourceMappingURL=messages-transform.d.ts.map