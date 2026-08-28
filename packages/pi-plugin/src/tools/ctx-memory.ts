import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getAuthorityManagedMarker } from "@magic-context/core/features/magic-context/context-authority";
import { WRITABLE_MEMORY_CATEGORIES } from "@magic-context/core/features/magic-context/memory";
import { getProjectEmbeddingSnapshot } from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	ClaimOperationInputError,
	ClaimOperationKeyReuseError,
} from "@magic-context/core/features/magic-context/memory/storage-claim-operations";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	assertCtxMemoryWriteShape,
	executeCtxMemoryClaimAction,
} from "@magic-context/core/tools/ctx-memory/claim-actions";
import {
	CTX_MEMORY_ANTI_MEMORY_RULE,
	CTX_MEMORY_DESCRIPTION,
	CTX_MEMORY_MUTATION_TOKEN_RULE,
} from "@magic-context/core/tools/ctx-memory/constants";
import type { CtxMemoryArgs } from "@magic-context/core/tools/ctx-memory/types";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const ALL_ACTIONS = [
	"create",
	"get",
	"list",
	"revise",
	"archive",
	"restore",
	"merge",
] as const;
const DREAMER_ONLY_ACTIONS = new Set<string>(["list"]);

const MutationTokenSchema = Type.Object({
	tokenVersion: Type.Number(),
	publicClaimId: Type.String(),
	revision: Type.Number(),
	contentDigest: Type.String(),
	lifecycleSeq: Type.Number(),
	applicabilityHeadsDigest: Type.String(),
	policyHeadsDigest: Type.String(),
});

const AntiMemorySchema = Type.Object(
	{
		trigger: Type.String(),
		rejectedStrategy: Type.String(),
		rejectionReason: Type.String(),
		saferAlternative: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		preconditions: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		attemptedApproach: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		observedFailure: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		rootCause: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		recovery: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		nonApplicableWhen: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	},
	{
		description:
			"Rejected-approach payload. Required with category REJECTED_APPROACH, and content must be omitted; invalid with any other category.",
	},
);

const ParamsSchema = Type.Object(
	{
		action: Type.Optional(
			Type.Union(
				ALL_ACTIONS.map((action) => Type.Literal(action)),
				{
					description: "create, get, list, revise, archive, restore, or merge",
				},
			),
		),
		content: Type.Optional(Type.String({ description: "Claim content" })),
		category: Type.Optional(
			Type.Union(
				WRITABLE_MEMORY_CATEGORIES.map((category) => Type.Literal(category)),
				{
					description: "Claim category or list filter",
				},
			),
		),
		antiMemory: Type.Optional(AntiMemorySchema),
		publicClaimId: Type.Optional(
			Type.String({
				description: "Public claim ID for single-claim mutations",
			}),
		),
		publicClaimIds: Type.Optional(
			Type.Array(Type.String(), { description: "Public claim IDs for get" }),
		),
		mutationToken: Type.Optional(MutationTokenSchema),
		mutationTokens: Type.Optional(
			Type.Array(MutationTokenSchema, {
				description: "Merge tokens ordered [target, ...sources]",
			}),
		),
		limit: Type.Optional(Type.Number({ description: "Maximum list results" })),
		reason: Type.Optional(
			Type.String({ description: "Lifecycle-change reason" }),
		),
	},
	{ additionalProperties: true },
);

type CtxMemoryParams = Static<typeof ParamsSchema>;

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function err(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError: true,
	};
}

export interface CtxMemoryToolDeps {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	memoryEnabled?: boolean;
	resolveProjectIdentity?: (directory: string) => string | undefined;
	allowDreamerActions?: boolean;
}

export function createCtxMemoryTool(
	deps: CtxMemoryToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	const dreamerAllowed = deps.allowDreamerActions === true;
	const resolveProject =
		deps.resolveProjectIdentity ?? resolveProjectIdentityForSession;
	return {
		name: "ctx_memory",
		label: "Magic Context: Memory",
		description: dreamerAllowed
			? `${CTX_MEMORY_DESCRIPTION}\n- list is enabled in this maintenance session.`
			: CTX_MEMORY_DESCRIPTION,
		parameters: ParamsSchema,
		async execute(toolCallId, rawParams, _signal, _onUpdate, ctx) {
			try {
				let params = rawParams as CtxMemoryParams & CtxMemoryArgs;
				params = unwrapImitatedReducedArgs(params, ["action"], {
					action: { type: "enum", values: ALL_ACTIONS },
					content: "string",
					category: { type: "enum", values: WRITABLE_MEMORY_CATEGORIES },
					antiMemory: CTX_MEMORY_ANTI_MEMORY_RULE,
					publicClaimId: "string",
					publicClaimIds: { type: "array", items: "string", maxItems: 20 },
					mutationToken: CTX_MEMORY_MUTATION_TOKEN_RULE,
					mutationTokens: {
						type: "array",
						items: CTX_MEMORY_MUTATION_TOKEN_RULE,
						maxItems: 20,
					},
					limit: "number",
					reason: "string",
				});
				const rawAction = (params as { action?: unknown }).action;
				if (rawAction === "approve" || rawAction === "enforce") {
					return err(
						"Error: approve and enforce are human-host-owned commands, not agent actions.",
					);
				}
				if (
					typeof rawAction !== "string" ||
					!ALL_ACTIONS.includes(rawAction as (typeof ALL_ACTIONS)[number])
				) {
					return err(
						`Error: Action '${String(rawAction)}' is not allowed in this context.`,
					);
				}
				const action = rawAction as (typeof ALL_ACTIONS)[number];
				assertCtxMemoryWriteShape({ ...params, action } as CtxMemoryArgs);
				if (!dreamerAllowed && DREAMER_ONLY_ACTIONS.has(action)) {
					return err(
						`Error: Action '${action}' is not allowed in this context.`,
					);
				}
				const projectIdentity = resolveProject(ctx.cwd);
				if (!projectIdentity) {
					return err(
						"Error: Could not resolve project identity for memory action.",
					);
				}
				await deps.ensureProjectRegistered?.(ctx.cwd, deps.db);
				const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
				if (
					snapshot
						? !snapshot.features.memoryEnabled
						: deps.memoryEnabled === false
				) {
					return err("Cross-session memory is disabled for this project.");
				}
				const sessionId = ctx.sessionManager.getSessionId();
				if (!sessionId) {
					return err("Error: ctx_memory requires an active session.");
				}
				if (!toolCallId && !["get", "list"].includes(action)) {
					return err(
						"Error: ctx_memory mutation requires a stable tool-call identity.",
					);
				}
				if (
					!["get", "list"].includes(action) &&
					getAuthorityManagedMarker(deps.db, projectIdentity)
				) {
					return err(
						"Error: memory authority is module-owned or transitioning; retry from an OpenCode host with staged-intent support.",
					);
				}
				const text = executeCtxMemoryClaimAction({
					db: deps.db,
					args: { ...params, action },
					projectIdentity,
					identity: {
						harness: "pi",
						sessionId,
						toolCallId: toolCallId || "read",
						projectIdentity,
					},
					actor: dreamerAllowed ? "agent:pi:dreamer" : "agent:pi",
				});
				return ok(text);
			} catch (error) {
				if (error instanceof ClaimOperationKeyReuseError) {
					return err(
						"Error: this tool call id was already committed with different arguments. Retry as a new call.",
					);
				}
				if (error instanceof ClaimOperationInputError) {
					return err(`Error: ${error.message}`);
				}
				throw error;
			}
		},
	};
}
