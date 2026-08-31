/**
 */
import type { OpenAiCompatWireMessage } from "./openai-compat-adjacency";

/* */
export const ISSUE_135_ORPHAN_WIRE: OpenAiCompatWireMessage[] = [
    { role: "user", content: "go" },
    {
        role: "assistant",
        content: null,
        tool_calls: [
            {
                id: "call_orphan",
                type: "function",
                function: { name: "read", arguments: '{"filePath":"x"}' },
            },
        ],
    },
    { role: "assistant", content: "[dropped]" },
    { role: "tool", tool_call_id: "call_orphan", content: "ok" },
];
