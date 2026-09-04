/**
 * Todo state synthesis — synthetic todowrite injection.
 *
 * Instead of inventing a custom `<current-todos>` block (which agents would
 * need to learn to parse), we synthesize a realistic `todowrite` tool part
 * and inject it into the latest assistant message on cache-busting passes.
 * The agent reads it through their existing todowrite-tracking mental model:
 * the wire shape is identical to OpenCode's stored todowrite tool parts
 * (`{type: "tool", callID, tool: "todowrite", state: {input, output, ...}}`).
 *
 * Cache safety:
 *   - Snapshot capture (in hook-handlers.ts on tool.execute.after) writes DB
 *     only — no message mutation.
 *   - Injection happens in transform-postprocess-phase.ts AFTER tagging and
 *     AFTER applyPendingOperations, so the synthetic part never gets tagged
 *     and is invisible to ctx_reduce and heuristic cleanup.
 *   - The synthetic callID is deterministic (sha256(stateJson)) so a stable
 *     snapshot produces a stable wire shape across passes; on defer passes we
 *     re-inject the same part at the same anchor, idempotent via callID match.
 *
 * Wire shape verified against:
 *   - OpenCode source: ~/Work/OSS/opencode/packages/opencode/src/tool/todo.ts
 *   - Production OpenCode DB sample: part where data LIKE '%"tool":"todowrite"%'
 */
export declare const TODO_STATUS_PENDING = "pending";
export declare const TODO_STATUS_IN_PROGRESS = "in_progress";
export declare const TODO_STATUS_COMPLETED = "completed";
export declare const TODO_STATUS_CANCELLED = "cancelled";
export declare const TODO_PRIORITY_HIGH = "high";
export declare const TODO_PRIORITY_MEDIUM = "medium";
export declare const TODO_PRIORITY_LOW = "low";
export declare const TODO_STATUSES: readonly ["pending", "in_progress", "completed", "cancelled"];
export declare const TODO_PRIORITIES: readonly ["high", "medium", "low"];
export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoPriority = (typeof TODO_PRIORITIES)[number];
export interface TodoItem {
    content: string;
    status: TodoStatus;
    priority: TodoPriority;
}
export declare const TERMINAL_STATUSES: Set<"pending" | "cancelled" | "completed" | "in_progress">;
/**
 * The set of statuses real OpenCode `todowrite` excludes when computing the
 * tool-part `title` (e.g. "3 todos"). OpenCode counts only `completed` as
 * "done"; cancelled todos still appear in the title's active count.
 *
 * Source: ~/Work/OSS/opencode/packages/opencode/src/tool/todo.ts:47-52.
 */
export declare const TITLE_DONE_STATUSES: Set<"pending" | "cancelled" | "completed" | "in_progress">;
/**
 * Normalize a `todowrite` args.todos array into a stable JSON string.
 * Returns `null` if the input is not a valid todo array.
 *
 * Some Pi users disable Magic Context's built-in `todowrite` and install a
 * third-party tool with the same name. Capture stays interoperable when that
 * tool emits Magic Context's exact todo shape, but it must fail closed for any
 * other status or priority values so bad state never reaches synthetic replay.
 *
 * Used by the snapshot capture path (`hook-handlers.ts`) to produce a
 * deterministic representation that survives JSON round-tripping with
 * stable field order.
 */
export declare function normalizeTodoStateJson(todos: unknown): string | null;
/**
 * A synthetic OpenCode tool part matching the wire shape of a real
 * `todowrite` tool result.
 *
 * NOTE — deliberate field omissions vs OpenCode `ToolPart`:
 *   - `id`, `sessionID`, `messageID`: OpenCode generates these from
 *     `Identifier.ascending(...)` for parts that originate from real tool
 *     calls and persist to the OpenCode DB. The synthetic part is
 *     transform-only (never persisted to OpenCode's DB), so these fields
 *     would be meaningless. The OpenCode wire serializer
 *     (`MessageV2.toModelMessagesEffect`) only reads `part.state.*`,
 *     `part.callID`, `part.tool`, and `part.metadata` — none of the
 *     omitted fields participate in wire serialization. Verified against
 *     ~/Work/OSS/opencode/packages/opencode/src/session/message-v2.ts:851-884.
 */
export interface SyntheticTodoPart {
    type: "tool";
    callID: string;
    tool: "todowrite";
    state: {
        status: "completed";
        input: {
            todos: TodoItem[];
        };
        output: string;
        title: string;
        metadata: {
            todos: TodoItem[];
            truncated: false;
        };
        time: {
            start: number;
            end: number;
        };
    };
    /** Marker so other plugin code can detect synthetic parts and skip them. */
    syntheticTodoMarker: true;
}
/**
 * Build a synthetic todowrite tool part from a normalized state JSON.
 * Returns `null` if the state is empty or all todos are terminal — in
 * those cases the agent doesn't need a reminder.
 */
export declare function buildSyntheticTodoPart(stateJson: string): SyntheticTodoPart | null;
/**
 * Compute a deterministic call_id from the snapshot JSON. Stable for stable
 * state; identical state across passes produces identical callID, which
 * gives byte-identical wire shape on both cache-busting and defer passes.
 *
 * Format chosen to clearly distinguish from real provider-generated IDs:
 *   - Anthropic: `toolu_<24 base62 chars>`
 *   - OpenAI:    `call_<random>`
 *   - Synthetic: `mc_synthetic_todo_<16 hex chars>`
 *
 * Providers do not validate callID format — they only require matching IDs
 * between tool_use and tool_result.
 */
export declare function computeSyntheticCallId(stateJson: string): string;
/**
 * Detect whether a part is a synthetic todo part this module produced.
 * Used to skip synthetic parts during tagging and other tool-walk passes.
 */
export declare function isSyntheticTodoPart(part: unknown): boolean;
//# sourceMappingURL=todo-view.d.ts.map