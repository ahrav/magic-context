import type { PluginContext } from "../../plugin/types";
/**
 * Whether a given tool is actually CALLABLE in a session's tool set.
 *
 * Magic Context registers tools process-globally, but a parent agent (or the
 * user's OpenCode config) can spawn a session with an explicit allow-list
 * tools map ({"*": false, read: true, ...}) that filters a tool out. For such
 * sessions any surface that urges or replays that tool — ctx_reduce §N§
 * prefixes and nudges, or synthetic todowrite pairs — is pure overhead urging
 * a tool the model cannot call (plus cargo-cult risk with no benefit).
 *
 * CACHE STABILITY: the verdict is resolved ONCE per session per tool from the
 * FIRST user message's tools map and cached for the process lifetime. Per-turn
 * tool maps can differ (mode switches toggle edit tools), and a flapping
 * verdict would oscillate provider-visible bytes — a per-turn HARD bust. The
 * first-message map is fixed at session spawn, so the verdict is deterministic
 * across passes and restarts.
 *
 * The ctx_reduce verdict intentionally remains frozen even when OpenCode's live
 * permission rules deny the tool. Its value gates guidance and the system-prompt
 * hash; changing it mid-session would invalidate the provider prefix for a
 * permission change that is otherwise not part of the prompt. Todowrite's
 * synthetic pair has a separate live permission check at cache-busting
 * boundaries, so this asymmetry is deliberate and load-bearing.
 *
 * Fail-open: no tools map (normal sessions), no wildcard-deny, or an
 * unreadable OpenCode DB all resolve to "available" — current behavior.
 */
/** Availability verdict plus whether it is final for the session's lifetime. */
export interface ToolAvailabilityVerdict {
    callable: boolean;
    /** True when resolved from the session's first user message (cached).
     *  False when the verdict is a provisional fail-open default — consumers
     *  that PERSIST state derived from the verdict (e.g. the system-prompt
     *  hash) must skip persistence until a frozen verdict exists, or a later
     *  final verdict flips the persisted bytes and busts the prompt cache. */
    frozen: boolean;
}
/**
 * Set whether `ctx_reduce` is registered process-globally. Called once at
 * plugin boot from the tool registry resolution. When false, every
 * `resolveCtxReduceAvailability*` call returns a frozen `callable: false`
 * verdict without consulting the per-session tools map or the OpenCode DB.
 */
export declare function setCtxReduceRegisteredGlobally(registered: boolean): void;
/** Test-only reset so the availability suite's default-true baseline is
 *  unaffected by a prior test that flipped the override. Production code
 *  never needs to re-enable mid-process (boot-resolved, process-stable). */
export declare function resetCtxReduceRegisteredGloballyForTest(): void;
/** Historical alias. ctx_reduce was the first consumer of this resolver; the
 * verdict shape is identical for every tool, so the name is kept so existing
 * ctx_reduce call sites stay untouched.
 */
export type CtxReduceAvailabilityVerdict = ToolAvailabilityVerdict;
type PermissionAction = "ask" | "allow" | "deny";
/** The small rule shape used by OpenCode's Permission.disabled evaluator. */
export interface PermissionRule {
    permission: string;
    pattern: string;
    action: PermissionAction;
}
/**
 * Resolve from the in-memory transform message array (preferred — free).
 * Caches the verdict on first resolution.
 */
export declare function resolveToolAvailabilityFromMessages(sessionId: string, toolName: string, messages: ReadonlyArray<{
    info?: {
        role?: string;
        tools?: unknown;
    };
}>): ToolAvailabilityVerdict;
/**
 * Resolve from the OpenCode DB (paths that may run before the transform has
 * seen any messages — e.g. the system-prompt hook, or tool.execute.after).
 * Falls back to "available" when the DB is absent (Pi-only installs) or the
 * read fails.
 */
export declare function resolveToolAvailability(sessionId: string, toolName: string): ToolAvailabilityVerdict;
/** Drop a cached verdict for one tool of one session (test/reset helper). */
export declare function clearToolAvailability(sessionId: string, toolName: string): void;
export declare function resolveCtxReduceAvailabilityFromMessages(sessionId: string, messages: ReadonlyArray<{
    info?: {
        role?: string;
        tools?: unknown;
    };
}>): CtxReduceAvailabilityVerdict;
export declare function resolveCtxReduceAvailability(sessionId: string): CtxReduceAvailabilityVerdict;
export declare function clearCtxReduceAvailability(sessionId: string): void;
/**
 * Apply OpenCode's Permission.disabled rule: the last matching permission
 * rule wins, and only a deny of the whole permission pattern disables it.
 * Keeping this evaluator pure makes the findLast behavior testable without a
 * live OpenCode server.
 */
export declare function permissionDisabled(toolName: string, rules: readonly PermissionRule[]): boolean;
/**
 * Read OpenCode's merged agent permissions plus the session overlay and apply
 * the same last-rule evaluator OpenCode uses. The SDK declarations in older
 * plugin peer versions do not expose the newer permission fields, so the
 * response is intentionally narrowed at this boundary.
 */
export declare function resolveToolPermissionDenied(client: PluginContext["client"], sessionId: string, toolName: string, activeAgent?: string): Promise<boolean>;
export declare function todowritePermissionDenied(client: PluginContext["client"], sessionId: string, activeAgent?: string): Promise<boolean>;
/** Cached live verdict used by defer passes; undefined means no bust has read it yet. */
export declare function cachedToolPermissionDenied(sessionId: string, toolName: string): boolean | undefined;
export declare function clearToolPermissionDenied(sessionId: string, toolName?: string): void;
export declare function hasLoggedCtxReducePermissionDeny(sessionId: string): boolean;
export declare function markCtxReducePermissionDenyLogged(sessionId: string): void;
export declare function resolveTodowriteAvailabilityFromMessages(sessionId: string, messages: ReadonlyArray<{
    info?: {
        role?: string;
        tools?: unknown;
    };
}>): ToolAvailabilityVerdict;
export declare function resolveTodowriteAvailability(sessionId: string): ToolAvailabilityVerdict;
export declare function clearTodowriteAvailability(sessionId: string): void;
export {};
//# sourceMappingURL=ctx-reduce-availability.d.ts.map