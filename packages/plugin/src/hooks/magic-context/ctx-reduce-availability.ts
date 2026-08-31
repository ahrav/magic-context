import type { PluginContext } from "../../plugin/types";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { sessionLog } from "../../shared/logger";
import { openCodeDbExists, withReadOnlySessionDb } from "./read-session-db";

/**
 *
 * A session's explicit tools map can exclude a globally registered tool.
 * A tools map such as `{"*": false, read: true}` excludes tools not explicitly enabled.
 * Guidance and synthetic calls must not target tools excluded by the session's tools map.
 *
 * The bounded cache retains each tool's first-user-message verdict until eviction.
 * A changing verdict would change provider-visible bytes every turn.
 *
 * The resolver keeps the `ctx_reduce` verdict frozen when live permissions deny the tool because the verdict gates guidance and the system-prompt hash.
 * Changing the ctx_reduce verdict mid-session would invalidate the provider prefix even though permission changes do not alter the prompt.
 * Todowrite checks live permissions only at cache-busting boundaries.
 *
 * When the tools map is absent, does not deny the wildcard, or the OpenCode DB is unreadable, availability defaults to true.
 */

/** The verdict records whether its result is final for the session's lifetime. */
export interface ToolAvailabilityVerdict {
    callable: boolean;
    /** `frozen` is true when the verdict comes from the session's first user message.
     * When `frozen` is false, consumers must not persist state derived from the verdict because a later final verdict can change persisted bytes and bust the prompt cache.
     * */
    frozen: boolean;
}

let ctxReduceRegisteredGlobally = true;

/**
 * `resolveCtxReduceAvailability*` returns a frozen `callable: false` verdict when `ctx_reduce` is not registered globally.
 */
export function setCtxReduceRegisteredGlobally(registered: boolean): void {
    ctxReduceRegisteredGlobally = registered;
}

/**
 * */
export function resetCtxReduceRegisteredGloballyForTest(): void {
    ctxReduceRegisteredGlobally = true;
}

/**
 */
export type CtxReduceAvailabilityVerdict = ToolAvailabilityVerdict;

const CTX_REDUCE_TOOL = "ctx_reduce";
const TODOWRITE_TOOL = "todowrite";

/**
 * Verdicts are cached independently for each `(tool, session)` pair.
 * The 1,000-entry cap supports at most 500 sessions when both `ctx_reduce` and `todowrite` have entries.
 */
const availabilityBySession = new BoundedSessionMap<boolean>(1000);

/** The cached permission verdict is updated only during cache-busting passes;
 * Defer passes reuse the cached permission verdict without a live permission read. */
const permissionDeniedBySession = new BoundedSessionMap<boolean>(2000);
const ctxReducePermissionDenyLogged = new BoundedSessionMap<boolean>(1000);

type PermissionAction = "ask" | "allow" | "deny";

/* */
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

/** A null result means the tools map carries no signal. */
function verdictFromToolsMap(tools: unknown, toolName: string): boolean | null {
    if (tools === null || typeof tools !== "object" || Array.isArray(tools)) return null;
    const map = tools as Record<string, unknown>;
    if (map[toolName] === true) return true;
    if (map[toolName] === false) return false;
    if (map["*"] === false) return false;
    return null;
}

/**
 * The resolver prefers the in-memory transform message array over the OpenCode DB.
 * The resolver caches verdicts derived from the first user message.
 */
function resolveToolAvailabilityFromMessages(
    sessionId: string,
    toolName: string,
    messages: ReadonlyArray<{ info?: { role?: string; tools?: unknown } }>,
): ToolAvailabilityVerdict {
    if (toolName === CTX_REDUCE_TOOL && !ctxReduceRegisteredGlobally) {
        return { callable: false, frozen: true };
    }
    const key = cacheKey(toolName, sessionId);
    const cached = availabilityBySession.get(key);
    if (cached !== undefined) return { callable: cached, frozen: true };

    for (const message of messages) {
        if (message.info?.role !== "user") continue;
        // First user message decides: explicit signal, or no-signal → available.
        // The first user message always produces a frozen verdict.
        const verdict = verdictFromToolsMap(message.info.tools, toolName) ?? true;
        availabilityBySession.set(key, verdict);
        return { callable: verdict, frozen: true };
    }
    // When no user message exists, the resolver fails open without freezing so the first user message can set the verdict.
    return { callable: true, frozen: false };
}

/**
 * The resolver reads the OpenCode DB and fails open when it is unavailable or unreadable.
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
    // The resolver freezes the fail-open verdict when no database exists so hash persistence can proceed.
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
 * The last matching `Permission.disabled` rule wins; only a deny of the whole permission pattern disables it.
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

/** The normalizer accepts both OpenCode's object shorthand and its already-expanded rules. */
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
            // OpenCode interprets a simple string permission as a whole-tool rule.
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
 * Session rules follow agent rules, so later session rules override agent rules.
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

/* */
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
