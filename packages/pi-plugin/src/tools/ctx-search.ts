/**
 *
 *
 *
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { recordDeliveredAntiMemoryUsage } from "@magic-context/core/features/magic-context/memory/storage-claim-operations";
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
import { packSearchResults } from "@magic-context/core/tools/ctx-search/render";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const ParamsSchema = Type.Object(
	{
		query: Type.Optional(
			Type.String({
				description:
					"Search query. Matches rejected-approach warnings, Primers, git commit messages, notes, and raw user/assistant message text. Positive project-memory claims require an opaque public claim id (mcm_<32hex>) or full revision locator.",
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
						'Optional. Restrict to specific sources. Examples: ["primer"] for standing project explanations, ["git_commit"] for "when did we change X", ["message"] for "did we discuss this earlier", ["note"] for parked decisions or follow-ups, ["git_commit","message"] for regression hunts. ["memory"] searches rejected-approach warnings and resolves exact positive-memory locators; broad positive-memory text retrieval remains disabled. Omit for all enabled sources.',
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
	/** The resolver allows home only when user-level configuration enables it. */
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

			// The search excludes messages after the last compartment boundary because they remain in the live context.
			// No compartment sets the boundary to 0, excluding every 1-based indexed message.
			const lastCompartmentEnd = getLastCompartmentEndMessage(
				deps.db,
				sessionId,
			);
			const messageOrdinalCutoff =
				lastCompartmentEnd >= 0 ? lastCompartmentEnd : 0;

			const visibleRevisionLocators = getVisibleRevisionLocators(
				deps.db,
				sessionId,
			);
			const renderDelivered = (
				results: Awaited<ReturnType<typeof unifiedSearch>>,
			) => {
				const packed = packSearchResults(query, results, sessionId);
				recordDeliveredAntiMemoryUsage(deps.db, packed.delivered);
				return packed.text;
			};

			// Exact-locator short-circuit:
			// The current-state provider resolves locator-only queries before lexical or semantic search.
			// Normal search runs when no locator resolves, preserving text-query corpus search.
			//
			// Locator-only resolution requires `params.sources` to permit `memory`.
			const memorySourceAllowed =
				params.sources === undefined || params.sources.includes("memory");
			const locatorShape = parseLocatorShapedQuery(query);
			if (locatorShape && memoryEnabled && memorySourceAllowed) {
				const locatorResults = resolveClaimsByLocatorsForSearch({
					db: deps.db,
					projectPath: projectIdentity,
					locators: locatorShape,
					// Using the locator count can make `limit: 1` return two IDs.
					// Using the locator count can exceed the shared hard ceiling.
					limit: normalizeSearchResultLimit(params.limit),
					visibleRevisionLocators,
				});
				if (locatorResults !== null) {
					return {
						content: [
							{
								type: "text",
								text: renderDelivered(locatorResults),
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
					explicitSearch: true,
				},
			);

			return {
				content: [
					{
						type: "text",
						text: renderDelivered(results),
					},
				],
				details: undefined,
			};
		},
	};
}
