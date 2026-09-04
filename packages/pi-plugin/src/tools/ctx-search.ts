/**
 * Pi's `ctx_search` parses its typebox parameters and hands them to the shared
 * `executeCtxSearch`, so ranking, packing, and memory-state wording match
 * OpenCode byte for byte.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import type { KernelClientResolver } from "@magic-context/core/shared/kernel-client";
import { CTX_SEARCH_DESCRIPTION } from "@magic-context/core/tools/ctx-search/constants";
import { executeCtxSearch } from "@magic-context/core/tools/ctx-search/execute";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const ParamsSchema = Type.Object(
	{
		query: Type.Optional(
			Type.String({
				description:
					"Search query. Matches project memories, Primers, git commit messages, notes, and raw user/assistant message text. A query made only of memory object ids (mem_<32hex>) resolves those memories directly.",
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
						'Optional. Restrict to specific sources. Examples: ["primer"] for standing project explanations, ["git_commit"] for "when did we change X", ["message"] for "did we discuss this earlier", ["note"] for parked decisions or follow-ups, ["git_commit","message"] for regression hunts. ["memory"] searches the project memories served by the memory daemon. Omit for all enabled sources; pass [] to search no sources.',
				},
			),
		),
	},
	{ additionalProperties: true },
);

type CtxSearchParams = Static<typeof ParamsSchema>;

export interface CtxSearchToolDeps {
	db: ContextDatabase;
	/** Serves the `memory` source; every other source reads the local database. */
	kernelClient: KernelClientResolver;
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
			signal,
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
			const execution = await executeCtxSearch(
				{
					db: deps.db,
					kernelClient: deps.kernelClient,
					ensureProjectRegistered: deps.ensureProjectRegistered,
					resolveProjectPath: resolveProject,
					memoryEnabled: deps.memoryEnabled,
					embeddingEnabled: deps.embeddingEnabled,
					gitCommitsEnabled: deps.gitCommitsEnabled,
				},
				params,
				{
					sessionID: ctx.sessionManager.getSessionId(),
					directory: ctx.cwd,
					...(signal ? { abort: signal } : {}),
				},
			);
			return {
				content: [{ type: "text", text: execution.text }],
				details: undefined,
				...(execution.status === "invalid" ? { isError: true } : {}),
			};
		},
	};
}
