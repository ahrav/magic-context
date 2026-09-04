import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { WRITABLE_MEMORY_CATEGORIES } from "@magic-context/core/features/magic-context/memory";
import { ClaimOperationInputError } from "@magic-context/core/features/magic-context/memory/claim-operation-contract";
import { getProjectEmbeddingSnapshot } from "@magic-context/core/features/magic-context/memory/embedding";
import {
	resolveProjectIdentityForSession,
	resolveProjectRootDirectory,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import type { KernelClientResolver } from "@magic-context/core/shared/kernel-client";
import {
	CTX_MEMORY_ANTI_MEMORY_RULE,
	CTX_MEMORY_DESCRIPTION,
} from "@magic-context/core/tools/ctx-memory/constants";
import { executeCtxMemory } from "@magic-context/core/tools/ctx-memory/execute";
import type { CtxMemoryArgs } from "@magic-context/core/tools/ctx-memory/types";
import { assertCtxMemoryWriteShape } from "@magic-context/core/tools/ctx-memory/write-shape";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const ALL_ACTIONS = [
	"create",
	"get",
	"list",
	"revise",
	"archive",
	"merge",
] as const;
const DREAMER_ONLY_ACTIONS = new Set<string>(["list"]);

export const CTX_MEMORY_PI_ACTOR = "agent:pi";
export const CTX_MEMORY_PI_DREAMER_ACTOR = "agent:pi:dreamer";

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
		expiresAt: Type.Optional(
			Type.Union([Type.Number(), Type.Null()], {
				description:
					"Epoch ms after which the warning stops surfacing; omitted writes default to 90 days out",
			}),
		),
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
					description: "create, get, list, revise, archive, or merge",
				},
			),
		),
		content: Type.Optional(
			Type.String({ description: "Memory content for create/revise/merge" }),
		),
		category: Type.Optional(
			Type.Union(
				WRITABLE_MEMORY_CATEGORIES.map((category) => Type.Literal(category)),
				{
					description:
						"Memory category for create/revise/merge or list filter",
				},
			),
		),
		antiMemory: Type.Optional(AntiMemorySchema),
		objectId: Type.Optional(
			Type.String({ description: "Object id for revise/archive" }),
		),
		objectIds: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Object ids for get, or the objects merge folds into one survivor",
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
	/** Resolves the client bound to the calling session and filesystem project root. */
	kernelClient: KernelClientResolver;
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
					objectId: "string",
					objectIds: { type: "array", items: "string", maxItems: 20 },
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
				if (!dreamerAllowed && DREAMER_ONLY_ACTIONS.has(action)) {
					return err(
						`Error: Action '${action}' is not allowed in this context.`,
					);
				}
				const args: CtxMemoryArgs = { ...params, action };
				assertCtxMemoryWriteShape(args);
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
				const mutation = !["get", "list"].includes(action);
				if (!toolCallId && mutation) {
					return err(
						"Error: ctx_memory mutation requires a stable tool-call identity.",
					);
				}
				const client = deps.kernelClient({
					sessionId,
					projectRoot: resolveProjectRootDirectory(ctx.cwd),
				});
				const text = await executeCtxMemory({
					client,
					args,
					action,
					identity: { sessionId, toolCallId: toolCallId || "read" },
					actor: dreamerAllowed
						? CTX_MEMORY_PI_DREAMER_ACTOR
						: CTX_MEMORY_PI_ACTOR,
					...(dreamerAllowed ? { sourceKind: "dreamer" as const } : {}),
				});
				return text.startsWith("Error:") ? err(text) : ok(text);
			} catch (error) {
				if (error instanceof ClaimOperationInputError) {
					return err(`Error: ${error.message}`);
				}
				throw error;
			}
		},
	};
}
