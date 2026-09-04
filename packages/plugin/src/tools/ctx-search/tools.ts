import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { CTX_SEARCH_DESCRIPTION, CTX_SEARCH_TOOL_NAME } from "./constants";
import { executeCtxSearch } from "./execute";
import type { CtxSearchArgs, CtxSearchToolDeps } from "./types";

export { CTX_SEARCH_LIGHT_DESCRIPTION } from "../light-descriptions";
export { type CtxSearchCallContext, type CtxSearchExecution, executeCtxSearch } from "./execute";

const ctxSearchArgsShape = {
    query: tool.schema
        .string()
        .optional()
        .describe(
            "Search query. Matches project memories, Primers, git commit messages, notes, and raw user/assistant message text. A query made only of memory object ids (mem_<32hex>) resolves those memories directly.",
        ),
    limit: tool.schema.number().optional().describe("Maximum results to return (default: 10)"),
    sources: tool.schema
        .array(tool.schema.enum(["memory", "message", "git_commit", "primer", "note"]))
        .optional()
        .describe(
            'Optional. Restrict to specific sources. Examples: ["primer"] for standing project explanations, ["git_commit"] for "when did we change X", ["message"] for "did we discuss this earlier", ["note"] for parked decisions or follow-ups, ["git_commit","message"] for regression hunts. ["memory"] searches the project memories served by the memory daemon. Omit for all enabled sources; pass [] to search no sources.',
        ),
};
// The tool definition exposes only the documented argument shape to the model
// Callers may still send extra arguments.
// `passthrough()` lets `execute()` receive fields that the model cannot see in the argument schema.
const ctxSearchArgsSchema = tool.schema.object(ctxSearchArgsShape).passthrough();

function createCtxSearchTool(deps: CtxSearchToolDeps): ToolDefinition {
    return tool({
        description: CTX_SEARCH_DESCRIPTION,
        args: ctxSearchArgsShape,
        async execute(rawArgs: CtxSearchArgs, toolContext) {
            const parsedArgs = ctxSearchArgsSchema.safeParse(rawArgs);
            const args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxSearchArgs;
            const execution = await executeCtxSearch(deps, args, toolContext);
            return execution.text;
        },
    });
}

export function createCtxSearchTools(deps: CtxSearchToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_SEARCH_TOOL_NAME]: createCtxSearchTool(deps),
    };
}
