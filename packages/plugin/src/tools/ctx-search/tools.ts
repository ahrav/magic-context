import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import {
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import { recordDeliveredAntiMemoryUsage } from "../../features/magic-context/memory/storage-claim-operations";
import {
    parseLocatorShapedQuery,
    resolveClaimsByLocatorsForSearch,
    type UnifiedSearchResult,
    unifiedSearch,
} from "../../features/magic-context/search";
import {
    describeQueryBoundsViolation,
    normalizeSearchResultLimit,
} from "../../features/magic-context/search-bounds";
import { getVisibleRevisionLocators } from "../../hooks/magic-context/inject-compartments";
import { CTX_SEARCH_DESCRIPTION, CTX_SEARCH_TOOL_NAME } from "./constants";
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
            "Search query. Matches rejected-approach warnings, Primers, git commit messages, notes, and raw user/assistant message text. Positive project-memory claims require an opaque public claim id (mcm_<32hex>) or full revision locator.",
        ),
    limit: tool.schema.number().optional().describe("Maximum results to return (default: 10)"),
    sources: tool.schema
        .array(tool.schema.enum(["memory", "message", "git_commit", "primer", "note"]))
        .optional()
        .describe(
            'Optional. Restrict to specific sources. Examples: ["primer"] for standing project explanations, ["git_commit"] for "when did we change X", ["message"] for "did we discuss this earlier", ["note"] for parked decisions or follow-ups, ["git_commit","message"] for regression hunts. ["memory"] searches rejected-approach warnings and resolves exact positive-memory locators; broad positive-memory text retrieval remains disabled. Omit for all enabled sources; pass [] to search no sources.',
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

    // The search hard-filters claims already rendered in the injected baseline.
    // Claims in `message[0]` are already visible, so excluding them preserves tokens for raw-history hits.
    const visibleRevisionLocators = getVisibleRevisionLocators(deps.db, toolContext.sessionID);

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

    const completeFrom = (results: UnifiedSearchResult[]): CtxSearchExecution => {
        const packed = packSearchResults(query, results, toolContext.sessionID);
        recordDeliveredAntiMemoryUsage(deps.db, packed.delivered);
        return {
            status: "complete",
            text: packed.text,
            prePack: results,
            delivered: packed.delivered,
            tokenCount: packed.tokenCount,
            omittedCount: packed.omittedCount,
            reason: packed.reason,
        };
    };

    // `parseLocatorShapedQuery` accepts locator lists only when they occupy the whole query.
    // `parseLocatorShapedQuery` returns null for ordinary text, allowing `unifiedSearch` to search the corpus.
    // If no locator resolves, the call falls through to `unifiedSearch`.
    //
    // The locator path must honor `args.sources`.
    // `sources: []` must not return claim content.
    // `sources: []` must not return claim content.
    // `sources: []` must not return claim content.
    const requestedSources = normalizeSources(args.sources);
    const memorySourceAllowed =
        requestedSources === undefined || requestedSources.includes("memory");
    const locatorShape = parseLocatorShapedQuery(query);
    if (locatorShape && memoryEnabled && memorySourceAllowed) {
        const locatorResults = resolveClaimsByLocatorsForSearch({
            db: deps.db,
            projectPath,
            locators: locatorShape,
            // `limit: 1` must return at most one locator result.
            // `limit: 1` must return at most one locator result.
            limit: normalizeSearchResultLimit(args.limit),
            visibleRevisionLocators,
        });
        if (locatorResults !== null) {
            return completeFrom(locatorResults);
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
        sources: requestedSources,
        explicitSearch: true,
    });

    return completeFrom(results);
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
