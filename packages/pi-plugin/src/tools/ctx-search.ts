/**
 * Pi-side wrapper for the `ctx_search` tool.
 *
 * The core search logic in `unifiedSearch()` is harness-agnostic — it operates
 * over the shared SQLite store. The pi-plugin only needs to:
 *
 *   1. Translate the LLM-provided arguments into the search options shape.
 *   2. Resolve session ID and project identity from the Pi extension context.
 *   3. Format results for the LLM the same way the OpenCode plugin does.
 *
 * `ctx_expand` is now registered alongside (see `./ctx-expand.ts`) — Pi
 * sessions are JSONL files, but the shared `readSessionChunk` reads
 * via the `RawMessageProvider` registry, so Pi just registers its own
 * provider for the duration of an expand call.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	parseLocatorShapedQuery,
	resolveClaimsByLocatorsForSearch,
	unifiedSearch,
} from "@magic-context/core/features/magic-context/search";
import {
	describeQueryBoundsViolation,
	normalizeSearchResultLimit,
	prepareExplicitQuery,
} from "@magic-context/core/features/magic-context/search-bounds";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getVisibleRevisionLocators } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { CTX_SEARCH_DESCRIPTION } from "@magic-context/core/tools/ctx-search/constants";
import { formatSearchResults } from "@magic-context/core/tools/ctx-search/render";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const ParamsSchema = Type.Object(
	{
		query: Type.Optional(
			Type.String({
				description:
					"Search query. Matches against Primers, git commit messages, notes, and raw user/assistant message text. Project-memory claims are NOT text-searchable; a query that is only opaque public claim ids (mcm_<32hex>) or full revision locators resolves those claims directly.",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum results to return (default: 10)",
			}),
		),
		sources: Type.Optional(
			Type.Array(
				Type.Union([
					Type.Literal("memory"),
					Type.Literal("message"),
					Type.Literal("git_commit"),
					Type.Literal("primer"),
					Type.Literal("note"),
				]),
				{
					description:
						'Optional. Restrict to specific sources. Examples: ["primer"] for standing project explanations, ["git_commit"] for "when did we change X", ["message"] for "did we discuss this earlier", ["note"] for parked decisions or follow-ups, ["git_commit","message"] for regression hunts. ["memory"] is accepted but returns nothing: broad project-memory retrieval is disabled until the claim retrieval projection is active. Omit for a broad search across all enabled sources.',
				},
			),
		),
	},
	{ additionalProperties: true },
);

type CtxSearchParams = Static<typeof ParamsSchema>;

export interface CtxSearchToolDeps {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	memoryEnabled?: boolean;
	embeddingEnabled?: boolean;
	gitCommitsEnabled?: boolean;
	/** Resolve a directory's project identity, allowing home only when user-level configuration enables it. */
	resolveProjectIdentity?: (directory: string) => string | undefined;
}

export function createCtxSearchTool(
	deps: CtxSearchToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	const resolveProject =
		deps.resolveProjectIdentity ?? resolveProjectIdentityForSession;
	return {
		name: "ctx_search",
		label: "Magic Context: Search",
		description: CTX_SEARCH_DESCRIPTION,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxSearchParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			params = unwrapImitatedReducedArgs(params, ["query"], {
				query: "string",
				limit: "number",
				sources: {
					type: "array",
					items: "string",
					maxItems: 5,
					values: ["memory", "message", "git_commit", "primer", "note"],
				},
			});
			const preflight = prepareExplicitQuery(params.query ?? "");
			if (!preflight.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${describeQueryBoundsViolation(preflight)}`,
						},
					],
					details: undefined,
					isError: true,
				};
			}
			const query = preflight.query;
			if (!query) {
				return {
					content: [{ type: "text", text: "Error: 'query' is required." }],
					details: undefined,
					isError: true,
				};
			}

			const sessionId = ctx.sessionManager.getSessionId();
			const projectIdentity = resolveProject(ctx.cwd);
			if (!projectIdentity) {
				return {
					content: [
						{
							type: "text",
							text: "Error: Could not resolve project identity for search.",
						},
					],
					details: undefined,
					isError: true,
				};
			}
			await deps.ensureProjectRegistered?.(ctx.cwd, deps.db);
			const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
			const memoryEnabled =
				snapshot?.features.memoryEnabled ?? deps.memoryEnabled;
			const embeddingEnabled = snapshot
				? snapshot.enabled || snapshot.gitCommitEnabled
				: deps.embeddingEnabled;
			const gitCommitsEnabled =
				snapshot?.gitCommitEnabled ?? deps.gitCommitsEnabled ?? false;

			// Only search message history up to the last compartment boundary —
			// anything after that (the live tail, including the current turn) is
			// still in context and already visible to the agent. When NO compartment
			// exists yet, the historian hasn't scrolled anything out of context, so
			// the boundary is 0: every indexed message (ordinals are 1-based) is in
			// the live tail and must be excluded. A negative sentinel here would mean
			// "search everything" and leak the current prompt back to the agent — the
			// exact opposite of the intent (issue #131).
			const lastCompartmentEnd = getLastCompartmentEndMessage(
				deps.db,
				sessionId,
			);
			const messageOrdinalCutoff =
				lastCompartmentEnd >= 0 ? lastCompartmentEnd : 0;

			// Hard-filter claims already rendered in the injected baseline.
			const visibleRevisionLocators = getVisibleRevisionLocators(
				deps.db,
				sessionId,
			);

			// Exact-locator short-circuit (parity with OpenCode ctx_search):
			// when the whole query is one or more claim/revision locators,
			// bypass the lexical+semantic lanes and resolve them through the
			// current-state provider. If nothing resolves we fall through to
			// the normal lanes so ordinary text still searches the corpus.
			//
			// Source restriction binds here too: this path runs before
			// `params.sources` reaches `unifiedSearch`, so without the check a
			// locator-shaped query would return claim content under a
			// restriction that names only non-memory sources, or under an
			// explicit empty list.
			const memorySourceAllowed =
				params.sources === undefined || params.sources.includes("memory");
			const locatorShape = parseLocatorShapedQuery(query);
			if (locatorShape && memoryEnabled && memorySourceAllowed) {
				const locatorResults = resolveClaimsByLocatorsForSearch({
					db: deps.db,
					projectPath: projectIdentity,
					locators: locatorShape,
					limit: Math.max(
						normalizeSearchResultLimit(params.limit),
						locatorShape.length,
					),
					visibleRevisionLocators,
				});
				if (locatorResults !== null) {
					return {
						content: [
							{
								type: "text",
								text: formatSearchResults(query, locatorResults, sessionId),
							},
						],
						details: undefined,
					};
				}
			}

			const results = await unifiedSearch(
				deps.db,
				sessionId,
				projectIdentity,
				query,
				{
					limit: normalizeSearchResultLimit(params.limit),
					memoryEnabled,
					embeddingEnabled,
					embedQuery: async (text, signal) => {
						const result = await embedTextForProject(
							projectIdentity,
							text,
							signal,
							"query",
						);
						return result?.vector ?? null;
					},
					isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
					maxMessageOrdinal: messageOrdinalCutoff,
					gitCommitsEnabled,
					sources: params.sources,
					// Explicit agent search → literal-probe multi-query recall
					// (parity with OpenCode's ctx_search). Pi auto-search leaves
					// this off to protect its latency budget.
					explicitSearch: true,
				},
			);

			return {
				content: [
					{
						type: "text",
						text: formatSearchResults(query, results, sessionId),
					},
				],
				details: undefined,
			};
		},
	};
}
