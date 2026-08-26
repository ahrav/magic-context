import type { Memory } from "../../../plugin/src/features/magic-context/memory";
import { ID_SHAPED_QUERY_MAX_TOKENS } from "../../../plugin/src/features/magic-context/search";
import type { TestHarness } from "../harness";
import { runScriptedToolCall } from "../scripted-tool-call";

type GoldMemoryId = number | Pick<Memory, "id">;

function idQuery(ids: readonly GoldMemoryId[]): string {
    if (ids.length === 0) {
        throw new Error("scriptedCtxSearchTurn requires at least one id");
    }
    if (ids.length > ID_SHAPED_QUERY_MAX_TOKENS) {
        throw new Error(
            `scriptedCtxSearchTurn accepts at most ${ID_SHAPED_QUERY_MAX_TOKENS} ids per turn`,
        );
    }
    return ids
        .map((value) => {
            const id = typeof value === "number" ? value : value.id;
            if (!Number.isSafeInteger(id) || id <= 0) {
                throw new Error(`scriptedCtxSearchTurn received invalid memory id: ${id}`);
            }
            return `#${id}`;
        })
        .join(" ");
}

/**
 * Execute one real `ctx_search` tool turn and return its wire `tool_result`
 * text. Memory ids become one id-shaped query in caller order. More than five
 * ids are rejected rather than chunked because chunking would no longer be one
 * tool turn.
 *
 * Candidate rows are searchable. Rows already injected into this session are
 * omitted by the plugin's `visibleMemoryIds` filter. The shared tool driver
 * calls `mock.reset()`, which wipes every installed matcher; callers must
 * reinstall any additional matchers for each subsequent step that needs them.
 */
export async function scriptedCtxSearchTurn(
    harness: TestHarness,
    sessionId: string,
    idsOrQuery: readonly GoldMemoryId[] | string,
): Promise<string> {
    const query = typeof idsOrQuery === "string" ? idsOrQuery : idQuery(idsOrQuery);
    const call = await runScriptedToolCall(harness, sessionId, {
        tool: "ctx_search",
        input: { query, sources: ["memory"], limit: 5 },
        prompt: `Search project memory for oracle evidence: ${query}`,
        followUpText: "oracle search complete",
    });
    return call.resultText;
}
