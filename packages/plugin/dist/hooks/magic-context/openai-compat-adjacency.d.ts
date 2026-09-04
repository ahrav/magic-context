/**
 * OpenAI-compatible chat adjacency invariant used by GitHub Copilot's wire format.
 *
 * Every assistant message with `tool_calls` must be immediately followed by
 * `role: "tool"` messages whose `tool_call_id` values cover exactly the ids
 * declared on that assistant message (order among tool messages may vary).
 *
 * Copilot re-translates this shape to Bedrock/Claude server-side; violating
 * adjacency here reproduces issue #135 (`tool_use` without adjacent `tool_result`).
 */
export type OpenAiCompatWireMessage = {
    role: string;
    content?: string | null | unknown;
    tool_calls?: Array<{
        id: string;
        type?: string;
        function?: {
            name: string;
            arguments: string;
        };
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
export declare function assertOpenAiCompatAdjacency(messages: OpenAiCompatWireMessage[]): AdjacencyResult;
export declare function formatWireSlice(messages: OpenAiCompatWireMessage[], centerIndex: number, radius?: number): string;
//# sourceMappingURL=openai-compat-adjacency.d.ts.map