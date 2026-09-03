import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import {
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import { resolveProjectRootDirectory } from "../../features/magic-context/memory/project-identity";
import { type UnifiedSearchResult, unifiedSearch } from "../../features/magic-context/search";
import {
    describeQueryBoundsViolation,
    normalizeSearchResultLimit,
} from "../../features/magic-context/search-bounds";
import { getVisibleRevisionLocators } from "../../hooks/magic-context/inject-compartments";
import { isAvailable, renderToolStateText } from "../../shared/kernel-client";
import { CTX_SEARCH_DESCRIPTION, CTX_SEARCH_TOOL_NAME } from "./constants";
import { parseObjectIdQuery, searchKernelMemoryRows } from "./kernel-memory-search";
import { normalizeCtxSearchArgs, prepareQueryFromNormalizedArgs } from "./query-input";
import { type ExplicitDeliveryReason, packSearchResults } from "./render";
import type { CtxSearchArgs, CtxSearchSource, CtxSearchToolDeps } from "./types";

export { CTX_SEARCH_LIGHT_DESCRIPTION } from "../light-descriptions";

const VALID_SOURCES: ReadonlySet<CtxSearchSource> = new Set([
    "memory",
    "message",
    "git_commit",
    "primer",
    "note",
]);

/**
 * `undefined` means `sources` was omitted; preserve [] so `unifiedSearch` searches no sources.
 * */
function normalizeSources(sources?: string[]): CtxSearchSource[] | undefined {
    if (sources === undefined) return undefined;
    const result: CtxSearchSource[] = [];
    const seen = new Set<CtxSearchSource>();
    for (const source of sources) {
        if (VALID_SOURCES.has(source as CtxSearchSource)) {
            const typed = source as CtxSearchSource;
            if (!seen.has(typed)) {
                seen.add(typed);
                result.push(typed);
            }
        }
    }
    return result;
}

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

export interface CtxSearchCallContext {
    sessionID: string;
    directory: string;
}

/**
 * `complete` includes rendered text, the pre-pack ranking, and results whose blocks survived packing.
 * Search failures throw instead of returning an empty ranking.
 *  empty ranking. */
export type CtxSearchExecution =
    | { status: "invalid"; text: string }
    | {
          status: "complete";
          text: string;
          prePack: UnifiedSearchResult[];
          delivered: UnifiedSearchResult[];
          tokenCount: number;
          omittedCount: number;
          reason: ExplicitDeliveryReason;
      };

/**
 */
export async function executeCtxSearch(
    deps: CtxSearchToolDeps,
    rawArgs: CtxSearchArgs,
    toolContext: CtxSearchCallContext,
): Promise<CtxSearchExecution> {
    const parsedArgs = ctxSearchArgsSchema.safeParse(rawArgs);
    let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxSearchArgs;
    args = normalizeCtxSearchArgs(args);
    // Non-string model-supplied `query` values are treated as missing rather than throwing.
    const preflight = prepareQueryFromNormalizedArgs(args);
    if (!preflight.ok) {
        return { status: "invalid", text: `Error: ${describeQueryBoundsViolation(preflight)}` };
    }
    const query = preflight.query;
    if (!query) {
        return { status: "invalid", text: "Error: 'query' is required." };
    }

    // Search only messages before the last compartment boundary; the live tail is already visible to the agent.
    // When no compartment exists, use boundary `0` to exclude every indexed message.
    // A negative sentinel would search everything and leak the current prompt back to the agent.
    const lastCompartmentEnd = getLastCompartmentEndMessage(deps.db, toolContext.sessionID);
    const messageOrdinalCutoff = lastCompartmentEnd >= 0 ? lastCompartmentEnd : 0;

    // Memories already rendered in the injected baseline are excluded from the `memory` source.
    // A hit in `message[0]` is already visible, so excluding it preserves tokens for unseen results.
    const visibleObjectIds = getVisibleRevisionLocators(deps.db, toolContext.sessionID);

    const projectPath = deps.resolveProjectPath(toolContext.directory);
    if (!projectPath) {
        return { status: "invalid", text: "Error: Could not resolve project identity for search." };
    }
    await deps.ensureProjectRegistered?.(toolContext.directory, deps.db);
    const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
    const memoryEnabled = embeddingSnapshot?.features.memoryEnabled ?? deps.memoryEnabled;
    const embeddingEnabled = embeddingSnapshot
        ? embeddingSnapshot.enabled || embeddingSnapshot.gitCommitEnabled
        : deps.embeddingEnabled;
    const gitCommitsEnabled =
        embeddingSnapshot?.gitCommitEnabled ?? deps.gitCommitsEnabled ?? false;

    const completeFrom = (
        results: UnifiedSearchResult[],
        memoryNote?: string,
    ): CtxSearchExecution => {
        const packed = packSearchResults(query, results, toolContext.sessionID);
        return {
            status: "complete",
            text: memoryNote ? `${memoryNote}\n\n${packed.text}` : packed.text,
            prePack: results,
            delivered: packed.delivered,
            tokenCount: packed.tokenCount,
            omittedCount: packed.omittedCount,
            reason: packed.reason,
        };
    };

    // The `memory` source is served by the daemon through the kernel client, gated on
    // freshness: a lagging projector answers `stale` and the search says so instead of
    // ranking rows that may miss recent writes. Every other source reads the local database,
    // so `memory` leaves the source list handed to `unifiedSearch`.
    const requestedSources = normalizeSources(args.sources);
    const memorySourceAllowed =
        requestedSources === undefined || requestedSources.includes("memory");
    const memoryOnly = requestedSources?.length === 1 && requestedSources[0] === "memory";
    const localSources = (requestedSources ?? [...VALID_SOURCES]).filter(
        (source) => source !== "memory",
    );
    let memoryNote: string | undefined;
    let memoryResults: UnifiedSearchResult[] = [];
    if (memoryEnabled && memorySourceAllowed) {
        const client = deps.kernelClient({
            sessionId: toolContext.sessionID,
            projectRoot: resolveProjectRootDirectory(toolContext.directory),
        });
        const read = await client.read({ surface: "explicit_search", gated: true });
        if (isAvailable(read)) {
            const hits = searchKernelMemoryRows({
                rows: read.rows,
                query,
                limit: normalizeSearchResultLimit(args.limit),
                excludeObjectIds: visibleObjectIds,
            });
            if (hits) {
                // An object-id query is answered by the daemon alone.
                if (parseObjectIdQuery(query)) return completeFrom(hits);
                memoryResults = hits;
            }
        } else {
            const text = renderToolStateText(read.state);
            if (memoryOnly) return { status: "invalid", text: `Error: ${text}` };
            memoryNote = `Memory: ${text}`;
        }
    }

    const results = await unifiedSearch(deps.db, toolContext.sessionID, projectPath, query, {
        limit: normalizeSearchResultLimit(args.limit),
        memoryEnabled,
        embeddingEnabled,
        embedQuery: async (text, signal) => {
            const result = await embedTextForProject(projectPath, text, signal, "query");
            return result;
        },
        isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
        readMessages: deps.readMessages,
        maxMessageOrdinal: messageOrdinalCutoff,
        gitCommitsEnabled,
        sources: localSources,
        explicitSearch: true,
    });

    if (memoryResults.length === 0) return completeFrom(results, memoryNote);
    const merged = [...memoryResults, ...results]
        .sort((left, right) => right.score - left.score)
        .slice(0, normalizeSearchResultLimit(args.limit));
    return completeFrom(merged, memoryNote);
}

function createCtxSearchTool(deps: CtxSearchToolDeps): ToolDefinition {
    return tool({
        description: CTX_SEARCH_DESCRIPTION,
        args: ctxSearchArgsShape,
        async execute(rawArgs: CtxSearchArgs, toolContext) {
            const execution = await executeCtxSearch(deps, rawArgs, toolContext);
            return execution.text;
        },
    });
}

export function createCtxSearchTools(deps: CtxSearchToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_SEARCH_TOOL_NAME]: createCtxSearchTool(deps),
    };
}
