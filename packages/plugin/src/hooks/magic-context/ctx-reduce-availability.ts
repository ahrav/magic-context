import type { PluginContext } from "../../plugin/types";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import { openCodeDbExists, withReadOnlySessionDb } from "./read-session-db";

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

// `ctx_reduce` is registered process-globally by the tool registry at boot.
// In compaction-off mode (the `compaction` config block's `enabled` field set
// to false) the registry skips registering it, so no session can ever call
// the tool — regardless of the per-session spawn tools map (a normal session
// with no tools map would otherwise fail-open to "callable"). This
// process-global override makes unregistration flow naturally to every
// ctx_reduce-availability consumer: the no-reduce guidance variant
// (system-prompt-hash.ts), Channel-1/Channel-2 nudges, and §N§ prefix
// injection (transform.ts). Default true (registered) preserves today's
// behavior for tests/legacy callers that never call the setter. The
// compaction-off mode reuses the existing no-reduce guidance variant
// machinery rather than minting a third template.
let ctxReduceRegisteredGlobally = true;

/**
 * Set whether `ctx_reduce` is registered process-globally. Called once at
 * plugin boot from the tool registry resolution. When false, every
 * `resolveCtxReduceAvailability*` call returns a frozen `callable: false`
 * verdict without consulting the per-session tools map or the OpenCode DB.
 */
export function setCtxReduceRegisteredGlobally(registered: boolean): void {
    ctxReduceRegisteredGlobally = registered;
}

/** Test-only reset so the availability suite's default-true baseline is
 *  unaffected by a prior test that flipped the override. Production code
 *  never needs to re-enable mid-process (boot-resolved, process-stable). */
export function resetCtxReduceRegisteredGloballyForTest(): void {
    ctxReduceRegisteredGlobally = true;
}

/** Historical alias. ctx_reduce was the first consumer of this resolver; the
 * verdict shape is identical for every tool, so the name is kept so existing
 * ctx_reduce call sites stay untouched.
 */
export type CtxReduceAvailabilityVerdict = ToolAvailabilityVerdict;

const CTX_REDUCE_TOOL = "ctx_reduce";
const TODOWRITE_TOOL = "todowrite";

/**
 * Verdicts are cached per (tool, session). Two tools resolve independently for
 * the same session, so the key is a composite. The NUL separator cannot appear
 * in either a tool name or an OpenCode session id. Cap covers ~500 sessions
 * across the two tools we currently resolve (ctx_reduce + todowrite).
 */
const availabilityBySession = new BoundedSessionMap<boolean>(1000);

/** The cached permission verdict is updated only during cache-busting passes;
 * defer passes reuse it without performing a live permission read. */
const permissionDeniedBySession = new BoundedSessionMap<boolean>(2000);
const ctxReducePermissionDenyLogged = new BoundedSessionMap<boolean>(1000);

type PermissionAction = "ask" | "allow" | "deny";

/** The small rule shape used by OpenCode's Permission.disabled evaluator. */
export interface PermissionRule {
    permission: string;
    pattern: string;
    action: PermissionAction;
}

function permissionCacheKey(toolName: string, sessionId: string): string {
    return `${toolName}\u0000${sessionId}`;
}

function cacheKey(toolName: string, sessionId: string): string {
    return `${toolName}\u0000${sessionId}`;
}

/** Verdict for one tool from one tools map; null = map carries no signal. */
function verdictFromToolsMap(tools: unknown, toolName: string): boolean | null {
    if (tools === null || typeof tools !== "object" || Array.isArray(tools)) return null;
    const map = tools as Record<string, unknown>;
    if (map[toolName] === true) return true;
    if (map[toolName] === false) return false;
    // Explicit allow-list (wildcard deny) without this tool → filtered out.
    if (map["*"] === false) return false;
    return null;
}

/**
 * Resolve from the in-memory transform message array (preferred — free).
 * Caches the verdict on first resolution.
 */
function resolveToolAvailabilityFromMessages(
    sessionId: string,
    toolName: string,
    messages: ReadonlyArray<{ info?: { role?: string; tools?: unknown } }>,
): ToolAvailabilityVerdict {
    // Process-global registration override: when ctx_reduce is not registered
    // (compaction-off mode) the tool is uncallable for every session, full
    // stop. Frozen so the system-prompt hash persists this verdict as the
    // session baseline (no provisional-then-flip cache bust).
    if (toolName === CTX_REDUCE_TOOL && !ctxReduceRegisteredGlobally) {
        return { callable: false, frozen: true };
    }
    const key = cacheKey(toolName, sessionId);
    const cached = availabilityBySession.get(key);
    if (cached !== undefined) return { callable: cached, frozen: true };

    for (const message of messages) {
        if (message.info?.role !== "user") continue;
        // First user message decides: explicit signal, or no-signal → available.
        // Either way the verdict is final — freeze it.
        const verdict = verdictFromToolsMap(message.info.tools, toolName) ?? true;
        availabilityBySession.set(key, verdict);
        return { callable: verdict, frozen: true };
    }
    // No user message in the array at all (not a real prompt — e.g. a stray
    // pass on an empty session). Fail open but do NOT freeze: caching true here
    // would lock a deny-list session into the tool's surface before its first
    // user message ever arrives to say otherwise.
    return { callable: true, frozen: false };
}

/**
 * Resolve from the OpenCode DB (paths that may run before the transform has
 * seen any messages — e.g. the system-prompt hook, or tool.execute.after).
 * Falls back to "available" when the DB is absent (Pi-only installs) or the
 * read fails.
 */
function resolveToolAvailability(sessionId: string, toolName: string): ToolAvailabilityVerdict {
    // Process-global registration override (see resolveToolAvailabilityFromMessages).
    if (toolName === CTX_REDUCE_TOOL && !ctxReduceRegisteredGlobally) {
        return { callable: false, frozen: true };
    }
    const key = cacheKey(toolName, sessionId);
    const cached = availabilityBySession.get(key);
    if (cached !== undefined) return { callable: cached, frozen: true };
    // No opencode.db at all: this handler only runs inside OpenCode, where the
    // DB always exists — this branch is test/degraded-install territory, not
    // the pre-first-user race. Treat as final so hash persistence proceeds.
    if (!openCodeDbExists()) return { callable: true, frozen: true };
    try {
        const row = withReadOnlySessionDb(
            (db) =>
                db
                    .prepare(
                        `SELECT json_extract(data, '$.tools') AS tools FROM message
                          WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
                          ORDER BY time_created ASC LIMIT 1`,
                    )
                    .get(sessionId) as { tools: string | null } | undefined,
        );
        if (!row) return { callable: true, frozen: false }; // session not persisted yet
        const verdict =
            row.tools === null ? null : verdictFromToolsMap(JSON.parse(row.tools), toolName);
        const resolved = verdict ?? true;
        availabilityBySession.set(key, resolved);
        return { callable: resolved, frozen: true };
    } catch (error) {
        sessionLog(sessionId, `${toolName} availability read failed (fail-open):`, error);
        return { callable: true, frozen: false };
    }
}

/** Drop a cached verdict for one tool of one session (test/reset helper). */
function clearToolAvailability(sessionId: string, toolName: string): void {
    availabilityBySession.delete(cacheKey(toolName, sessionId));
}

// --- ctx_reduce convenience wrappers (behavior-identical to the original) ---

export function resolveCtxReduceAvailabilityFromMessages(
    sessionId: string,
    messages: ReadonlyArray<{ info?: { role?: string; tools?: unknown } }>,
): CtxReduceAvailabilityVerdict {
    return resolveToolAvailabilityFromMessages(sessionId, CTX_REDUCE_TOOL, messages);
}

export function resolveCtxReduceAvailability(sessionId: string): CtxReduceAvailabilityVerdict {
    return resolveToolAvailability(sessionId, CTX_REDUCE_TOOL);
}

export function clearCtxReduceAvailability(sessionId: string): void {
    clearToolAvailability(sessionId, CTX_REDUCE_TOOL);
}

// --- live OpenCode permission signal ---

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseData(value: unknown): unknown {
    if (isRecord(value) && Object.hasOwn(value, "data")) return value.data;
    return value;
}

function escapeRegExpLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function permissionNameMatches(rulePermission: string, toolName: string): boolean {
    if (rulePermission === "*" || rulePermission === toolName) return true;
    if (!rulePermission.includes("*")) return false;
    const pattern = rulePermission.split("*").map(escapeRegExpLiteral).join(".*");
    return new RegExp(`^${pattern}$`).test(toolName);
}

/**
 * Apply OpenCode's Permission.disabled rule: the last matching permission
 * rule wins, and only a deny of the whole permission pattern disables it.
 * Keeping this evaluator pure makes the findLast behavior testable without a
 * live OpenCode server.
 */
export function permissionDisabled(toolName: string, rules: readonly PermissionRule[]): boolean {
    let finalRule: PermissionRule | undefined;
    for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index];
        if (rule && permissionNameMatches(rule.permission, toolName)) {
            finalRule = rule;
            break;
        }
    }
    return finalRule?.action === "deny" && finalRule.pattern === "*";
}

function actionOf(value: unknown): PermissionAction | null {
    return value === "ask" || value === "allow" || value === "deny" ? value : null;
}

function appendPermissionRule(
    target: PermissionRule[],
    permission: unknown,
    pattern: unknown,
    action: unknown,
): void {
    if (typeof permission !== "string" || permission.length === 0) return;
    const normalizedAction = actionOf(action);
    if (!normalizedAction) return;
    const patterns = Array.isArray(pattern) ? pattern : [pattern ?? "*"];
    for (const candidate of patterns) {
        if (typeof candidate === "string") {
            target.push({ permission, pattern: candidate, action: normalizedAction });
        }
    }
}

/** Normalize both OpenCode's object shorthand and its already-expanded rules. */
function permissionRules(value: unknown): PermissionRule[] {
    if (Array.isArray(value)) {
        const result: PermissionRule[] = [];
        for (const item of value) {
            if (!isRecord(item)) continue;
            appendPermissionRule(
                result,
                item.permission ?? item.tool ?? item.name,
                item.pattern,
                item.action ?? item.value,
            );
        }
        return result;
    }
    if (!isRecord(value)) return [];

    const result: PermissionRule[] = [];
    if (Array.isArray(value.rules)) result.push(...permissionRules(value.rules));
    for (const [permission, configured] of Object.entries(value)) {
        if (permission === "rules") continue;
        const simpleAction = actionOf(configured);
        if (simpleAction) {
            // OpenCode's simple string form (`todowrite: "deny"`) expands to
            // the same whole-tool rule used by Permission.disabled.
            appendPermissionRule(result, permission, "*", simpleAction);
            continue;
        }
        if (!isRecord(configured)) continue;
        for (const [pattern, action] of Object.entries(configured)) {
            appendPermissionRule(result, permission, pattern, action);
        }
    }
    return result;
}

function activeAgentNameFromSession(value: unknown): string | undefined {
    if (!isRecord(value)) return undefined;
    const agent = value.agent;
    return typeof agent === "string" && agent.length > 0 ? agent : undefined;
}

/**
 * Read OpenCode's merged agent permissions plus the session overlay and apply
 * the same last-rule evaluator OpenCode uses. The SDK declarations in older
 * plugin peer versions do not expose the newer permission fields, so the
 * response is intentionally narrowed at this boundary.
 */
export async function resolveToolPermissionDenied(
    client: PluginContext["client"],
    sessionId: string,
    toolName: string,
    activeAgent?: string,
): Promise<boolean> {
    const sdk = client as unknown as {
        app?: { agents?: () => Promise<unknown> };
        session?: { get?: (input: { path: { id: string } }) => Promise<unknown> };
    };
    if (!sdk.app?.agents || !sdk.session?.get) {
        throw new Error("OpenCode permission APIs are unavailable");
    }

    const [agentsResponse, sessionResponse] = await Promise.all([
        sdk.app.agents(),
        sdk.session.get({ path: { id: sessionId } }),
    ]);
    const agents = responseData(agentsResponse);
    const session = responseData(sessionResponse);
    const agentName = activeAgent ?? activeAgentNameFromSession(session);
    const agent = Array.isArray(agents)
        ? agents.find((candidate) => isRecord(candidate) && candidate.name === agentName)
        : undefined;
    const agentRules = permissionRules(isRecord(agent) ? agent.permission : undefined);
    const sessionRules = permissionRules(
        isRecord(session) ? (session.permission ?? session.permissions) : undefined,
    );
    const denied = permissionDisabled(toolName, [...agentRules, ...sessionRules]);
    permissionDeniedBySession.set(permissionCacheKey(toolName, sessionId), denied);
    return denied;
}

export function todowritePermissionDenied(
    client: PluginContext["client"],
    sessionId: string,
    activeAgent?: string,
): Promise<boolean> {
    return resolveToolPermissionDenied(client, sessionId, TODOWRITE_TOOL, activeAgent);
}

/** Cached live verdict used by defer passes; undefined means no bust has read it yet. */
export function cachedToolPermissionDenied(
    sessionId: string,
    toolName: string,
): boolean | undefined {
    return permissionDeniedBySession.get(permissionCacheKey(toolName, sessionId));
}

export function clearToolPermissionDenied(sessionId: string, toolName?: string): void {
    if (toolName) {
        permissionDeniedBySession.delete(permissionCacheKey(toolName, sessionId));
    } else {
        permissionDeniedBySession.delete(permissionCacheKey(TODOWRITE_TOOL, sessionId));
        permissionDeniedBySession.delete(permissionCacheKey(CTX_REDUCE_TOOL, sessionId));
    }
    ctxReducePermissionDenyLogged.delete(sessionId);
}

export function hasLoggedCtxReducePermissionDeny(sessionId: string): boolean {
    return ctxReducePermissionDenyLogged.get(sessionId) === true;
}

export function markCtxReducePermissionDenyLogged(sessionId: string): void {
    ctxReducePermissionDenyLogged.set(sessionId, true);
}

// --- todowrite convenience wrappers ---

export function resolveTodowriteAvailabilityFromMessages(
    sessionId: string,
    messages: ReadonlyArray<{ info?: { role?: string; tools?: unknown } }>,
): ToolAvailabilityVerdict {
    return resolveToolAvailabilityFromMessages(sessionId, TODOWRITE_TOOL, messages);
}

export function resolveTodowriteAvailability(sessionId: string): ToolAvailabilityVerdict {
    return resolveToolAvailability(sessionId, TODOWRITE_TOOL);
}

export function clearTodowriteAvailability(sessionId: string): void {
    clearToolAvailability(sessionId, TODOWRITE_TOOL);
}
