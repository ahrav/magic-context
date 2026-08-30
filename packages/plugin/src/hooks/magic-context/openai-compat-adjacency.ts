/**
 * OpenAI-compatible chat adjacency invariant used by GitHub Copilot's wire format.
 *
 * Every assistant message with `tool_calls` must be immediately followed by
 * `role: "tool"` messages whose `tool_call_id` values cover exactly the ids
 * declared on that assistant message (order among tool messages may vary).
 *
 * Copilot re-translates this shape to Bedrock/Claude server-side; violating
 * adjacency here reproduces the orphan-tool wire failure (`tool_use` without
 * adjacent `tool_result`).
 */

export type OpenAiCompatWireMessage = {
    role: string;
    content?: string | null | unknown;
    tool_calls?: Array<{
        id: string;
        type?: string;
        function?: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
};

export type AdjacencyViolation = {
    index: number;
    kind: "missing_tool_messages" | "orphan_tool_message" | "unmatched_tool_call_id";
    assistantToolCallIds?: string[];
    followingRoles?: string[];
    toolCallId?: string;
    detail: string;
};

export type AdjacencyResult = {
    ok: boolean;
    violations: AdjacencyViolation[];
};

export function assertOpenAiCompatAdjacency(messages: OpenAiCompatWireMessage[]): AdjacencyResult {
    const violations: AdjacencyViolation[] = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== "assistant" || !msg.tool_calls || msg.tool_calls.length === 0) {
            continue;
        }

        const expectedIds = msg.tool_calls.map((tc) => tc.id);
        const expectedSet = new Set(expectedIds);
        const collected = new Map<string, number>();

        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") {
            const toolMsg = messages[j];
            const id = toolMsg.tool_call_id;
            if (!id) {
                violations.push({
                    index: i,
                    kind: "unmatched_tool_call_id",
                    detail: `tool message at index ${j} missing tool_call_id`,
                });
            } else if (!expectedSet.has(id)) {
                violations.push({
                    index: i,
                    kind: "unmatched_tool_call_id",
                    toolCallId: id,
                    assistantToolCallIds: expectedIds,
                    detail: `tool message at index ${j} references unexpected id ${id}`,
                });
            } else {
                collected.set(id, j);
            }
            j++;
        }

        const followingRoles = messages
            .slice(i + 1, Math.min(messages.length, i + 4))
            .map((m) => m.role);
        const missing = expectedIds.filter((id) => !collected.has(id));
        if (missing.length > 0) {
            violations.push({
                index: i,
                kind: "missing_tool_messages",
                assistantToolCallIds: expectedIds,
                followingRoles,
                detail:
                    missing.length === expectedIds.length
                        ? `assistant at index ${i} has tool_calls but next messages are not contiguous tool role (following: ${followingRoles.join(", ") || "none"})`
                        : `assistant at index ${i} missing tool results for: ${missing.join(", ")}`,
            });
            if (j < messages.length && messages[j].role !== "tool") {
                const last = violations[violations.length - 1];
                last.detail += `; blocked by ${messages
                    .slice(i + 1, j + 1)
                    .map((m, off) => `${m.role}[${i + 1 + off}]`)
                    .join(", ")}`;
            }
        }
    }

    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role !== "tool") continue;
        const id = messages[i].tool_call_id ?? "";
        if (!id) continue;
        let found = false;
        for (let k = i - 1; k >= 0; k--) {
            const prev = messages[k];
            if (prev.role === "assistant" && prev.tool_calls?.some((tc) => tc.id === id)) {
                const between = messages.slice(k + 1, i);
                if (between.every((m) => m.role === "tool")) {
                    found = true;
                }
                break;
            }
            if (prev.role === "assistant" || prev.role === "user") break;
        }
        if (!found) {
            violations.push({
                index: i,
                kind: "orphan_tool_message",
                toolCallId: id,
                detail: `tool message at index ${i} is not immediately after its assistant tool_calls`,
            });
        }
    }

    return { ok: violations.length === 0, violations };
}
