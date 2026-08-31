/**
 * This module injects synthetic `todowrite` parts to expose task-list state.
 *
 * The module uses a `todowrite` tool part rather than a custom block so agents can use existing task-list tracking.
 * The code injects the synthetic part into the latest assistant message on cache-busting passes.
 * Agents read the injected part through their existing `todowrite` tracking model.
 * The synthetic part uses the same wire shape as stored OpenCode `todowrite` parts.
 *
 * Cache safety:
 * Snapshot capture in `hook-handlers.ts` on `tool.execute.after` writes only to the DB; it does not mutate messages.
 * Injection in `transform-postprocess-phase.ts` runs after tagging and `applyPendingOperations`.
 * Injection runs after `applyPendingOperations`, so tagging cannot process the synthetic part.
 * The synthetic part is invisible to `ctx_reduce` and heuristic cleanup.
 * A stable `stateJson` produces a stable `callID` across passes.
 * On defer passes, injection reuses the same part at the same anchor.
 * A matching `callID` makes reinjection idempotent.
 *
 */

import { createHash } from "node:crypto";

export const TODO_STATUS_PENDING = "pending";
export const TODO_STATUS_IN_PROGRESS = "in_progress";
export const TODO_STATUS_COMPLETED = "completed";
export const TODO_STATUS_CANCELLED = "cancelled";

export const TODO_PRIORITY_HIGH = "high";
export const TODO_PRIORITY_MEDIUM = "medium";
export const TODO_PRIORITY_LOW = "low";

export const TODO_STATUSES = [
    TODO_STATUS_PENDING,
    TODO_STATUS_IN_PROGRESS,
    TODO_STATUS_COMPLETED,
    TODO_STATUS_CANCELLED,
] as const;

export const TODO_PRIORITIES = [
    TODO_PRIORITY_HIGH,
    TODO_PRIORITY_MEDIUM,
    TODO_PRIORITY_LOW,
] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

interface TodoInputItem {
    content: string;
    status: TodoStatus;
    priority?: TodoPriority;
}

export interface TodoItem {
    content: string;
    status: TodoStatus;
    priority: TodoPriority;
}

const TODO_STATUS_SET = new Set<TodoStatus>(TODO_STATUSES);
const TODO_PRIORITY_SET = new Set<TodoPriority>(TODO_PRIORITIES);

export const TERMINAL_STATUSES = new Set<TodoStatus>([
    TODO_STATUS_COMPLETED,
    TODO_STATUS_CANCELLED,
]);

/**
 * `title` treats only `completed` todos as done; cancelled todos remain in its active count.
 *
 */
export const TITLE_DONE_STATUSES = new Set<TodoStatus>([TODO_STATUS_COMPLETED]);

const SYNTHETIC_CALL_ID_PREFIX = "mc_synthetic_todo_";

/**
 * `normalizeTodoStateJson` returns stable JSON for valid task-list arrays.
 * `normalizeTodoStateJson` returns `null` when `todos` is not a valid work-item array.
 *
 * `normalizeTodoStateJson` returns `null` for unsupported statuses and priorities.
 *
 * `normalizeTodoStateJson` preserves field order across JSON round-trips.
 */
export function normalizeTodoStateJson(todos: unknown): string | null {
    if (!Array.isArray(todos)) return null;

    const normalized: TodoItem[] = [];
    for (const todo of todos) {
        if (!isTodoItem(todo)) return null;
        normalized.push({
            content: todo.content,
            status: todo.status,
            priority: todo.priority ?? TODO_PRIORITY_MEDIUM,
        });
    }

    return JSON.stringify(normalized);
}

/**
 *
 *     ~/Work/OSS/opencode/packages/opencode/src/session/message-v2.ts:851-884.
 */
export interface SyntheticTodoPart {
    type: "tool";
    callID: string;
    tool: "todowrite";
    state: {
        status: "completed";
        input: { todos: TodoItem[] };
        output: string;
        title: string;
        metadata: { todos: TodoItem[]; truncated: false };
        time: { start: number; end: number };
    };
    /** `syntheticTodoMarker` lets plugin code skip synthetic parts. */
    syntheticTodoMarker: true;
}

/**
 * The function returns `null` when the state is empty or every task-list item is terminal.
 */
export function buildSyntheticTodoPart(stateJson: string): SyntheticTodoPart | null {
    const todos = parseTodoState(stateJson);
    if (todos === null || todos.length === 0) return null;

    if (todos.every((t) => TERMINAL_STATUSES.has(t.status))) return null;

    const callID = computeSyntheticCallId(stateJson);
    // The title text matches OpenCode's `${todos.length - completed.length} todos` expression.
    // The count excludes only completed todos, not cancelled todos, per the planning-tool contract.
    const activeCount = todos.filter((t) => !TITLE_DONE_STATUSES.has(t.status)).length;

    // The output matches OpenCode's todowrite output: pretty-printed JSON of the full todos array.
    const output = JSON.stringify(todos, null, 2);

    const ts = 0;

    return {
        type: "tool",
        callID,
        tool: "todowrite",
        state: {
            status: "completed",
            input: { todos },
            output,
            title: `${activeCount} todos`,
            metadata: { todos, truncated: false },
            time: { start: ts, end: ts },
        },
        syntheticTodoMarker: true,
    };
}

/**
 *
 *
 */
export function computeSyntheticCallId(stateJson: string): string {
    const hash = createHash("sha256").update(stateJson).digest("hex").slice(0, 16);
    return `${SYNTHETIC_CALL_ID_PREFIX}${hash}`;
}

/**
 * Tagging and tool-walk passes skip synthetic parts.
 */
export function isSyntheticTodoPart(part: unknown): boolean {
    if (part === null || typeof part !== "object") return false;
    const p = part as {
        syntheticTodoMarker?: unknown;
        callID?: unknown;
        type?: unknown;
        tool?: unknown;
    };
    if (p.syntheticTodoMarker === true) return true;
    // Require `type === "tool"` and `tool === "todowrite"` so unrelated objects with matching `callID` prefixes do not match.
    return (
        p.type === "tool" &&
        p.tool === "todowrite" &&
        typeof p.callID === "string" &&
        p.callID.startsWith(SYNTHETIC_CALL_ID_PREFIX)
    );
}

function parseTodoState(stateJson: string): TodoItem[] | null {
    if (stateJson.length === 0) return null;
    try {
        const parsed = JSON.parse(stateJson);
        if (!Array.isArray(parsed)) return null;
        const result: TodoItem[] = [];
        for (const item of parsed) {
            if (!isTodoItem(item)) return null;
            result.push({
                content: item.content,
                status: item.status,
                priority: item.priority ?? TODO_PRIORITY_MEDIUM,
            });
        }
        return result;
    } catch {
        return null;
    }
}

function isTodoStatus(value: unknown): value is TodoStatus {
    return typeof value === "string" && TODO_STATUS_SET.has(value as TodoStatus);
}

function isTodoPriority(value: unknown): value is TodoPriority {
    return typeof value === "string" && TODO_PRIORITY_SET.has(value as TodoPriority);
}

function isTodoItem(value: unknown): value is TodoInputItem {
    if (value === null || typeof value !== "object") return false;
    const todo = value as Record<string, unknown>;
    return (
        typeof todo.content === "string" &&
        isTodoStatus(todo.status) &&
        (todo.priority === undefined || isTodoPriority(todo.priority))
    );
}
