/**
 * The harness-neutral body of `ctx_search`. The OpenCode and Pi tool wrappers
 * parse their own argument shapes and call `executeCtxSearch`, so both
 * harnesses rank, pack, and word memory states the same way.
 */

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
import { recordKernelMemoryRetrievals } from "../../hooks/magic-context/kernel-claim-usage";
import {
    disabled,
    isAvailable,
    MAX_READ_OBJECT_IDS,
    type MemoryState,
    type ReadRow,
    renderToolStateText,
} from "../../shared/kernel-client";
import {
    parseObjectIdQuery,
    readObjectRowsChunked,
    searchKernelMemoryRows,
} from "./kernel-memory-search";
import { normalizeCtxSearchArgs, prepareQueryFromNormalizedArgs } from "./query-input";
import { type ExplicitDeliveryReason, packSearchResults } from "./render";
import type { CtxSearchArgs, CtxSearchSource, CtxSearchToolDeps } from "./types";

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

/** The wrappers fall back to raw arguments when schema parsing fails, so `sources` is validated as an array of supported names before any iteration: a non-array would throw an unhandled TypeError, and a misspelled name silently dropped would search nothing and report a misleading "no results". Answers the error text or `null` when valid. commentlint: allow(JUDGE) */
function invalidSourcesError(sources: unknown): string | null {
    if (sources === undefined) return null;
    if (!Array.isArray(sources)) {
        return "Error: 'sources' must be an array of source names.";
    }
    const unknown = sources.filter(
        (source) => typeof source !== "string" || !VALID_SOURCES.has(source as CtxSearchSource),
    );
    if (unknown.length > 0) {
        return `Error: unknown source${unknown.length === 1 ? "" : "s"}: ${unknown.map((source) => JSON.stringify(source)).join(", ")}. Supported sources: ${[...VALID_SOURCES].join(", ")}.`;
    }
    return null;
}

export interface CtxSearchCallContext {
    sessionID: string;
    directory: string;
    /** The host tool call's abort signal, forwarded into the kernel read and the local search's embedding requests. */
    abort?: AbortSignal;
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

export async function executeCtxSearch(
    deps: CtxSearchToolDeps,
    rawArgs: CtxSearchArgs,
    toolContext: CtxSearchCallContext,
): Promise<CtxSearchExecution> {
    const args = normalizeCtxSearchArgs(rawArgs);
    // Non-string model-supplied `query` values are treated as missing rather than throwing.
    const preflight = prepareQueryFromNormalizedArgs(args);
    if (!preflight.ok) {
        return { status: "invalid", text: `Error: ${describeQueryBoundsViolation(preflight)}` };
    }
    const query = preflight.query;
    if (!query) {
        return { status: "invalid", text: "Error: 'query' is required." };
    }
    const sourcesError = invalidSourcesError((rawArgs as { sources?: unknown }).sources);
    if (sourcesError) {
        return { status: "invalid", text: sourcesError };
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
    const projectRoot = resolveProjectRootDirectory(toolContext.directory);
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
        recordKernelMemoryRetrievals({
            db: deps.db,
            projectPath,
            projectRoot,
            objectIds: packed.delivered.flatMap((result) =>
                result.source === "memory" || result.source === "anti_memory"
                    ? [result.publicClaimId]
                    : [],
            ),
        });
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
    if (!memoryEnabled) {
        if (memoryOnly) {
            return {
                status: "invalid",
                text: `Error: ${renderToolStateText(disabled())}`,
            };
        }
        // A mixed request that names `memory` keeps its local sources; the note reports the skipped kernel lane so local results do not pass as a searched memory source.
        if (requestedSources?.includes("memory")) {
            memoryNote = `Memory: ${renderToolStateText(disabled())}`;
        }
    }
    // The local search and kernel read are independent except for object-id queries, so starting both concurrently pays the slower round-trip instead of their sum. commentlint: allow(JUDGE)
    const startLocalSearch = () =>
        unifiedSearch(deps.db, toolContext.sessionID, projectPath, query, {
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
            ...(toolContext.abort ? { signal: toolContext.abort } : {}),
        });
    // An object-id query is daemon-first with local search as fallback only, and a memory-only request has no local sources, so neither starts the local search eagerly. commentlint: allow(JUDGE)
    const idQuery = parseObjectIdQuery(query);
    let localResultsPromise: ReturnType<typeof startLocalSearch> | null = null;
    if (!idQuery && !memoryOnly) {
        localResultsPromise = startLocalSearch();
        // The no-op handler prevents an unawaited local-search rejection from becoming unhandled on an early return; awaiting the promise later still propagates it. commentlint: allow(JUDGE)
        localResultsPromise.catch(() => {});
    }
    if (memoryEnabled && memorySourceAllowed) {
        const client = deps.kernelClient({
            sessionId: toolContext.sessionID,
            projectRoot,
        });
        // An id query filters the read so a named object beyond the daemon's row cap still resolves; the chunked read splits on byte-budget truncation so every named id resolves or is reported unresolved by name. A pasted list over the filter bound falls back to the unfiltered snapshot instead of failing the search. commentlint: allow(JUDGE)
        const filteredIds = idQuery && idQuery.length <= MAX_READ_OBJECT_IDS ? idQuery : null;
        let memoryRows: ReadRow[] | null = null;
        let memoryState: MemoryState | null = null;
        let memoryTruncated = false;
        let unresolvedObjectIds: string[] = [];
        if (filteredIds) {
            const read = await readObjectRowsChunked({
                client,
                surface: "explicit_search",
                gated: true,
                objectIds: filteredIds,
                ...(toolContext.abort ? { signal: toolContext.abort } : {}),
            });
            if (read.ok) {
                memoryRows = read.rows;
                unresolvedObjectIds = read.unresolvedObjectIds;
            } else {
                memoryState = read.state;
            }
        } else {
            const read = await client.read({
                surface: "explicit_search",
                gated: true,
                ...(toolContext.abort ? { signal: toolContext.abort } : {}),
            });
            if (isAvailable(read)) {
                memoryRows = read.rows;
                memoryTruncated = read.truncated;
            } else {
                memoryState = read.state;
            }
        }
        if (memoryRows) {
            const notes: string[] = [];
            if (unresolvedObjectIds.length > 0) {
                notes.push(
                    `Memory: unresolved object id${unresolvedObjectIds.length === 1 ? "" : "s"} (the daemon read stayed truncated): ${unresolvedObjectIds.join(", ")}`,
                );
            }
            // A truncated snapshot drops the oldest rows, so a lexical hit that lives only in an omitted memory is silently missing; the note keeps "no results" from reading as a complete search. commentlint: allow(JUDGE)
            if (memoryTruncated) {
                notes.push(
                    "Memory: the memory read was truncated; older memories were not searched.",
                );
            }
            if (notes.length > 0) memoryNote = notes.join("\n");
            const hits = searchKernelMemoryRows({
                rows: memoryRows,
                query,
                limit: normalizeSearchResultLimit(args.limit),
                excludeObjectIds: visibleObjectIds,
            });
            if (hits) {
                // An object-id query is answered by the daemon alone.
                if (idQuery) return completeFrom(hits, memoryNote);
                memoryResults = hits;
            }
        } else if (memoryState) {
            const text = renderToolStateText(memoryState);
            if (memoryOnly) return { status: "invalid", text: `Error: ${text}` };
            memoryNote = `Memory: ${text}`;
        }
    }

    const results = await (localResultsPromise ?? startLocalSearch());

    if (memoryResults.length === 0) return completeFrom(results, memoryNote);
    const merged = [...memoryResults, ...results]
        .sort((left, right) => right.score - left.score)
        .slice(0, normalizeSearchResultLimit(args.limit));
    return completeFrom(merged, memoryNote);
}
