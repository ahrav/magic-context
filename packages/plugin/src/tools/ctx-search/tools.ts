import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import {
    embedTextForProject,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
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

/** Validate and normalize the `sources` arg. Drops unknown strings (the enum
 *  constraint catches them at the schema layer, but we still want a safe
 *  runtime check for plugins/tests that call this directly). Returns
 *  `undefined` only when the caller OMITTED `sources`; an explicit [] must stay
 *  [] so unifiedSearch honors the documented "no sources" meaning instead of
 *  widening back to "all sources". */
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
            "Search query. Matches against memory content, Primers, git commit messages, and raw user/assistant message text.",
        ),
    limit: tool.schema.number().optional().describe("Maximum results to return (default: 10)"),
    sources: tool.schema
        .array(tool.schema.enum(["memory", "message", "git_commit", "primer", "note"]))
        .optional()
        .describe(
            'Optional. Restrict to specific sources. Examples: ["primer"] for standing project explanations, ["git_commit"] for "when did we change X", ["memory"] for naming conventions, ["message"] for "did we discuss this earlier", ["note"] for parked decisions or follow-ups, ["git_commit","message"] for regression hunts. Omit for a broad search across all enabled sources; pass [] to search no sources.',
        ),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxSearchArgsSchema = tool.schema.object(ctxSearchArgsShape).passthrough();

export interface CtxSearchCallContext {
    sessionID: string;
    directory: string;
}

/** Structured explicit-delivery outcome. `invalid` carries the same error
 *  text the tool returns; `complete` carries the rendered text plus the
 *  pre-pack ranking and the results whose blocks survived packing. A search
 *  failure propagates as a thrown error — incomplete evidence, never an
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
 * Execute one explicit ctx_search call. The tool's `execute` delegates here,
 * so direct-ID lookup, multi-probe recall, source filters, visible-memory
 * filtering, ordinal cutoffs, and token packing stay on one shared path
 * whether the caller wants text or the structured outcome.
 */
export async function executeCtxSearch(
    deps: CtxSearchToolDeps,
    rawArgs: CtxSearchArgs,
    toolContext: CtxSearchCallContext,
): Promise<CtxSearchExecution> {
    const parsedArgs = ctxSearchArgsSchema.safeParse(rawArgs);
    let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxSearchArgs;
    args = normalizeCtxSearchArgs(args);
    // Exactly one normalization pass (shared with recovery), then
    // the type-safe preflight: a model-supplied non-string query
    // reads as missing instead of throwing out of tool execution.
    const preflight = prepareQueryFromNormalizedArgs(args);
    if (!preflight.ok) {
        return { status: "invalid", text: `Error: ${describeQueryBoundsViolation(preflight)}` };
    }
    const query = preflight.query;
    if (!query) {
        return { status: "invalid", text: "Error: 'query' is required." };
    }

    // Only search message history up to the last compartment boundary —
    // anything after that (the live tail, including the current turn) is
    // still in context and already visible to the agent. When NO compartment
    // exists yet, the historian hasn't scrolled anything out of context, so
    // the boundary is 0: every indexed message (ordinals are 1-based) is in
    // the live tail and must be excluded. A negative sentinel here would mean
    // "search everything" and leak the current prompt back to the agent — the
    // exact opposite of the intent (issue #131).
    const lastCompartmentEnd = getLastCompartmentEndMessage(deps.db, toolContext.sessionID);
    const messageOrdinalCutoff = lastCompartmentEnd >= 0 ? lastCompartmentEnd : 0;

    // Hard-filter claims already rendered in the injected baseline.
    // They're visible in message[0], so returning them wastes output
    // tokens and crowds out high-signal raw-history hits.
    const visibleRevisionLocators = getVisibleRevisionLocators(deps.db, toolContext.sessionID);

    // Resolve the session's actual project from `toolContext.directory`
    // each call. OpenCode's top-level `ctx.directory` (the launch dir)
    // can differ from the session's working directory when the user
    // runs `opencode -s <id>` from outside the project.
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

    // Exact-locator short-circuit: when the whole query is one or more
    // claim/revision locators, bypass the lexical+semantic lanes and
    // resolve them through the current-state provider. The agent is given
    // locators everywhere (<project-memory> lines, dashboard, guidance).
    // Whole-query locator list only — `parseLocatorShapedQuery` returns
    // null for ordinary text so it still searches the corpus. If no
    // locator resolves (foreign hidden, missing) the call falls through
    // to the normal lanes.
    const locatorShape = parseLocatorShapedQuery(query);
    if (locatorShape && memoryEnabled) {
        const locatorResults = resolveClaimsByLocatorsForSearch({
            db: deps.db,
            projectPath,
            locators: locatorShape,
            limit: Math.max(normalizeSearchResultLimit(args.limit), locatorShape.length),
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
        sources: normalizeSources(args.sources),
        // Explicit agent search → enable literal-probe multi-query
        // recall for symbol/command/path lookups. Auto-search hints
        // (the hot path) leave this off to protect their latency.
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
