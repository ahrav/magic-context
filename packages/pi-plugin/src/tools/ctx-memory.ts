/**
 * Pi-side wrapper for the `ctx_memory` tool.
 *
 * Action surface mirrors OpenCode's `packages/plugin/src/tools/ctx-memory/tools.ts`.
 * Two tiers of actions:
 *
 *  Primary (for any agent that can call ctx_memory):
 *    - write: insert a new memory (or no-op + bump seenCount on dedup hit)
 *    - archive: soft-delete a memory (status = 'archived'), optional reason
 *    - update: rewrite a memory's content (recomputes normalized_hash + queues re-embed)
 *    - merge: combine N memories into one canonical, supersede the rest
 *
 *  Dreamer-only (gated on `allowDreamerActions: true`):
 *    - list: list active memories for the current project
 *  (memory verification + classification are no longer tool actions — the verify
 *   and classify dreamer tasks apply them host-side from a manifest.)
 *
 * Allowlist gating mirrors OpenCode's `allowedActions` deps field. In OpenCode,
 * the dreamer subagent gets the full action surface because `toolContext.agent
 * === DREAMER_AGENT`. Pi has no agent identity inside child processes, so we
 * use an explicit flag (`--magic-context-dreamer-actions`) wired through the
 * subagent extension entry. Same effective behavior, different transport.
 *
 * Parity reference (OpenCode):
 *   - `tools/ctx-memory/types.ts` for action enum
 *   - `tools/ctx-memory/tools.ts` for handler logic
 *   - `plugin/tool-registry.ts` for the primary allowedActions (CTX_MEMORY_ACTIONS)
 *
 * Memories are project-scoped via `resolveProjectIdentity(ctx.cwd)` and stored
 * in the shared cortexkit DB, so a memory written from the pi-plugin is
 * immediately visible to OpenCode sessions on the same project (and vice
 * versa).
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	archiveMemory,
	getMemoriesByIds,
	getMemoriesByProject,
	getMemoryByHash,
	getMemoryById,
	hasMemoryClassifiedAtColumn,
	hasMemoryShareableColumn,
	insertMemoryIdempotent,
	type Memory,
	type MemoryCategory,
	mergeMemoryStats,
	saveEmbedding,
	supersededMemory,
	updateMemorySeenCount,
	V2_MEMORY_CATEGORIES,
} from "@magic-context/core/features/magic-context/memory";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { invalidateMemory } from "@magic-context/core/features/magic-context/memory/embedding-cache";
import { computeNormalizedHash } from "@magic-context/core/features/magic-context/memory/normalize-hash";
import {
	normalizeStoredProjectPath,
	resolveProjectIdentityForSession,
	storedPathBelongsToIdentity,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	decideMemoryPolicy,
	exactMemoryContentDigests,
	filterMemoriesByPolicy,
	memoriesEligibleForEmbedding,
	readMemoryPolicyRows,
} from "@magic-context/core/features/magic-context/memory/storage-claim-visibility";
import { sha256Utf8Hex } from "@magic-context/core/features/magic-context/memory/storage-claims";
import type { MemoryClaimOperationIdentity } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	ClaimOperationKeyReuseError,
	computeClaimRequestDigest,
	hasMemoryClaimsCompatSchema,
	type MemoryClaimOperationEnvelope,
	readMemoryClaimOperationResult,
	runMemoryClaimOperationInCurrentTransaction,
	updateMemoryContentWithClaimsInCurrentTransaction,
	withClaimsWriteCapabilityInCurrentTransaction,
	withMemoryClaimGenerationContextInCurrentTransaction,
} from "@magic-context/core/features/magic-context/memory/storage-memory-claims";
import {
	type ContextDatabase,
	queueMemoryMutation,
} from "@magic-context/core/features/magic-context/storage";
import {
	expandWorkspaceIdentitySetWithAliases,
	resolveStoredPathWorkspaceIdentity,
	resolveWorkspaceIdentitySet,
	resolveWorkspaceShareCategories,
	storedPathBelongsToWorkspace,
} from "@magic-context/core/features/magic-context/workspaces";
import { log } from "@magic-context/core/shared/logger";
import { CTX_MEMORY_DESCRIPTION } from "@magic-context/core/tools/ctx-memory/constants";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";

const DEFAULT_LIST_LIMIT = 10;

// Mirrors OpenCode CTX_MEMORY_DREAMER_ACTIONS. `delete` was removed — it was an
// exact alias of `archive` (both soft-archive); `archive` is the single
// soft-remove action. Primary agents get write/archive/update/merge/get on the
// memories they already see (with ids) in the injected project-memory block;
// `list` (bulk enumeration) stays dreamer-only. `get` is the id-shaped read
// that the user-facing <project-memory> ids imply but no other primary action
// covered — the agent is given a memory id (dashboard, guidance) and there is
// no other way to look it up. Memory verification (file mapping) and
// classification are no longer tool actions — the verify and classify dreamer
// tasks apply them host-side from a manifest.
const ALL_ACTIONS = [
	"write",
	"archive",
	"update",
	"merge",
	"get",
	"list",
] as const;
type CtxMemoryAction = (typeof ALL_ACTIONS)[number];

const DREAMER_ONLY_ACTIONS: ReadonlySet<CtxMemoryAction> = new Set(["list"]);

const GET_MAX_IDS = 20;

const ParamsSchema = Type.Object(
	{
		action: Type.Optional(
			Type.Union(
				ALL_ACTIONS.map((a) => Type.Literal(a)),
				{
					description:
						"What to do: write, update, archive, merge, get, or list",
				},
			),
		),
		content: Type.Optional(
			Type.String({
				description:
					"The memory text — one standalone fact (required for write, update, merge)",
			}),
		),
		category: Type.Optional(
			Type.Union(
				V2_MEMORY_CATEGORIES.map((c) => Type.Literal(c)),
				{
					description:
						"What kind of fact this is (required for write; optional merge override)",
				},
			),
		),
		ids: Type.Optional(
			Type.Array(Type.Number(), {
				description:
					"Target memory id(s) from <project-memory>: update takes exactly one, archive one or more, merge two or more, get one to twenty",
			}),
		),
		limit: Type.Optional(
			Type.Number({
				description: "Max results for list (default: 10)",
			}),
		),
		reason: Type.Optional(
			Type.String({
				description: "Why the memory is being archived (optional, recommended)",
			}),
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

function normalizeLimit(limit?: number): number {
	if (typeof limit !== "number" || !Number.isFinite(limit))
		return DEFAULT_LIST_LIMIT;
	return Math.max(1, Math.floor(limit));
}

function formatMemoryList(
	memories: Memory[],
	policyLabels?: Map<number, string>,
): string {
	if (memories.length === 0) return "No active memories found.";

	const rows = memories.map((m) => ({
		id: String(m.id),
		category: m.category,
		status: m.status,
		verification: m.verificationStatus,
		trust: policyLabels?.get(m.id) ?? "",
		updated: new Date(m.updatedAt).toISOString(),
		content: m.content.replace(/\s+/g, " ").trim(),
	}));
	const headers = {
		id: "ID",
		category: "CATEGORY",
		status: "STATUS",
		verification: "VERIFY",
		trust: "TRUST",
		updated: "UPDATED",
		content: "CONTENT",
	};
	const widths = {
		id: Math.max(headers.id.length, ...rows.map((r) => r.id.length)),
		category: Math.max(
			headers.category.length,
			...rows.map((r) => r.category.length),
		),
		status: Math.max(
			headers.status.length,
			...rows.map((r) => r.status.length),
		),
		verification: Math.max(
			headers.verification.length,
			...rows.map((r) => r.verification.length),
		),
		trust: Math.max(headers.trust.length, ...rows.map((r) => r.trust.length)),
		updated: Math.max(
			headers.updated.length,
			...rows.map((r) => r.updated.length),
		),
	};
	const fmt = (r: (typeof rows)[number] | typeof headers) =>
		[
			r.id.padEnd(widths.id),
			r.category.padEnd(widths.category),
			r.status.padEnd(widths.status),
			r.verification.padEnd(widths.verification),
			r.trust.padEnd(widths.trust),
			r.updated.padEnd(widths.updated),
			r.content,
		].join(" | ");
	return [
		`Found ${rows.length} active ${rows.length === 1 ? "memory" : "memories"}:`,
		"",
		fmt(headers),
		[
			"-".repeat(widths.id),
			"-".repeat(widths.category),
			"-".repeat(widths.status),
			"-".repeat(widths.verification),
			"-".repeat(widths.trust),
			"-".repeat(widths.updated),
			"-------",
		].join("-+-"),
		...rows.map(fmt),
	].join("\n");
}

function isPrimaryMutableMemory(memory: Memory): boolean {
	return (
		(memory.status === "active" || memory.status === "permanent") &&
		memory.supersededByMemoryId === null
	);
}

function inactiveMemoryError(
	id: number,
	action: "updating" | "merging" | "archiving",
): string {
	return `Error: Memory with ID ${id} is archived or superseded; restore it before ${action}.`;
}

// Envelopes require a digest; the tool's claim identities always carry one,
// so the cast only narrows the optional field.
function toClaimOperationEnvelope(
	identity: MemoryClaimOperationIdentity,
): MemoryClaimOperationEnvelope {
	return {
		producer: identity.producer,
		operationKey: identity.operationKey,
		requestDigest: identity.requestDigest as string,
	};
}

// Per-id not-found / not-visible wording. Sharing one message between the two
// states avoids an existence oracle for foreign memories — a caller that knows
// a memory is hidden by workspace share policy should not be able to
// distinguish "this id is foreign and not shared" from "this id does not
// exist" by reading the error text.
const getNotVisibleMessage = (id: number): string =>
	`id ${id}: not found or not visible from this project`;

function formatGetOutput(args: {
	requestedIds: number[];
	memoriesById: Map<number, Memory>;
	policyLabels?: Map<number, string>;
}): string {
	const parts: string[] = [];
	for (const id of args.requestedIds) {
		const memory = args.memoriesById.get(id);
		if (!memory) {
			parts.push(getNotVisibleMessage(id));
		} else {
			parts.push(formatMemoryList([memory], args.policyLabels));
		}
	}
	return parts.join("\n\n");
}

function updateMemoryContentInCurrentTransaction(
	db: ContextDatabase,
	memory: Memory,
	content: string,
	normalizedHash: string,
	operationIdentity?: MemoryClaimOperationIdentity,
): boolean {
	if (hasMemoryClaimsCompatSchema(db)) {
		const outcome = withClaimsWriteCapabilityInCurrentTransaction(db, () => {
			return updateMemoryContentWithClaimsInCurrentTransaction(
				db,
				{
					producer: operationIdentity?.producer ?? "ctx-memory-pi",
					operationKey:
						operationIdentity?.operationKey ?? `update:${crypto.randomUUID()}`,
					requestDigest:
						operationIdentity?.requestDigest ??
						computeClaimRequestDigest({
							id: memory.id,
							content,
							normalizedHash,
						}),
				},
				{ memoryId: memory.id, content, normalizedHash },
			);
		});
		invalidateMemory(memory.projectPath, memory.id);
		return outcome.replayed;
	}
	db.prepare(
		"UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
	).run(content, normalizedHash, Date.now(), memory.id);
	// The classify `shareable` verdict was scored against the OLD content; new
	// content invalidates it. Fail closed → private; the dreamer re-scores later.
	if (hasMemoryShareableColumn(db)) {
		db.prepare("UPDATE memories SET shareable = 0 WHERE id = ?").run(memory.id);
	}
	// Clear the classify marker so the changed fact is re-scored next classify run.
	if (hasMemoryClassifiedAtColumn(db)) {
		db.prepare("UPDATE memories SET classified_at = NULL WHERE id = ?").run(
			memory.id,
		);
	}
	db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(
		memory.id,
	);
	invalidateMemory(memory.projectPath, memory.id);
	return false;
}

function queueEmbedding(args: {
	deps: CtxMemoryToolDeps;
	projectIdentity: string;
	memoryId: number;
	content: string;
}) {
	const snapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
	if (!snapshot?.enabled) return;
	// Hard-hidden / rejected content never leaves the process, remote
	// embedding providers included.
	if (
		!memoriesEligibleForEmbedding(args.deps.db, [args.memoryId]).has(
			args.memoryId,
		)
	) {
		return;
	}
	const contentDigest = sha256Utf8Hex(args.content);
	void (async () => {
		try {
			// The queued closure runs after an arbitrary delay: re-check
			// eligibility at the provider boundary and bind it to the exact
			// bytes this closure captured, so a quarantine/rejection or
			// rewrite that landed after enqueue cannot leak the content to
			// the provider. Mirrors the OpenCode tool.
			if (
				!memoriesEligibleForEmbedding(args.deps.db, [args.memoryId]).has(
					args.memoryId,
				)
			) {
				log(
					`[magic-context-pi] embedding skipped for memory ${args.memoryId}: no longer eligible at provider drain.`,
				);
				return;
			}
			if (
				exactMemoryContentDigests(args.deps.db, [args.memoryId]).get(
					args.memoryId,
				) !== contentDigest
			) {
				log(
					`[magic-context-pi] embedding skipped for memory ${args.memoryId}: content changed before the provider call.`,
				);
				return;
			}
			const result = await embedTextForProject(
				args.projectIdentity,
				args.content,
			);
			if (!result) {
				log(
					`[magic-context-pi] embedding skipped for memory ${args.memoryId}: provider unavailable.`,
				);
				return;
			}
			saveEmbedding(args.deps.db, args.memoryId, result.vector, result.modelId);
			log(`[magic-context-pi] proactively embedded memory ${args.memoryId}.`);
		} catch (error) {
			log(
				`[magic-context-pi] embedding failed for memory ${args.memoryId}:`,
				error,
			);
		}
	})();
}

export interface CtxMemoryToolDeps {
	db: ContextDatabase;
	ensureProjectRegistered?: (
		directory: string,
		db: ContextDatabase,
	) => Promise<void>;
	memoryEnabled?: boolean;
	embeddingEnabled?: boolean;
	/** Resolve a directory's project identity, allowing home only when user-level configuration enables it. */
	resolveProjectIdentity?: (directory: string) => string | undefined;
	/** When true, the dreamer-only `list` action is exposed. Set by the subagent
	 *  extension entry when the parent passes `--magic-context-dreamer-actions`.
	 *  Default: false (primary set only: write/archive/update/merge). */
	allowDreamerActions?: boolean;
}

export function createCtxMemoryTool(
	deps: CtxMemoryToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	const dreamerAllowed = deps.allowDreamerActions === true;
	const resolveProject =
		deps.resolveProjectIdentity ?? resolveProjectIdentityForSession;
	const description = dreamerAllowed
		? `${CTX_MEMORY_DESCRIPTION}\n- list: enumerate stored memories (maintenance sessions).`
		: CTX_MEMORY_DESCRIPTION;

	return {
		name: "ctx_memory",
		label: "Magic Context: Memory",
		description,
		parameters: ParamsSchema,
		async execute(
			toolCallId,
			params: CtxMemoryParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			try {
				params = unwrapImitatedReducedArgs(params, ["action"], {
					action: { type: "enum", values: ALL_ACTIONS },
					content: "string",
					category: { type: "enum", values: V2_MEMORY_CATEGORIES },
					ids: { type: "array", items: "number", maxItems: 100 },
					limit: "number",
					reason: "string",
				});
				if (params.action === undefined) {
					return err(
						"Error: Action 'undefined' is not allowed in this context.",
					);
				}
				// Gate dreamer-only actions on the allowlist flag. Mirrors
				// OpenCode's `if (toolContext.agent !== DREAMER_AGENT && !allowedActions.includes(args.action))`.
				if (!dreamerAllowed && DREAMER_ONLY_ACTIONS.has(params.action)) {
					return err(
						`Error: Action '${params.action}' is not allowed in this context.`,
					);
				}

				const projectIdentity = resolveProject(ctx.cwd);
				if (!projectIdentity) {
					return err(
						"Error: Could not resolve project identity for memory action.",
					);
				}
				const sessionId = ctx.sessionManager.getSessionId();
				// claim_operations is UNIQUE(producer, operation_key) DB-wide while
				// tool-call ids are only unique within a session, so the key carries
				// the session id (mirrors OpenCode's toolContext.sessionID scoping).
				const claimOperationIdentity = (
					suffix: string,
					request: unknown,
				): MemoryClaimOperationIdentity | undefined =>
					toolCallId
						? {
								producer: "ctx-memory-pi",
								operationKey: `${sessionId}:${toolCallId}:${suffix}`,
								requestDigest: computeClaimRequestDigest(request),
							}
						: undefined;
				await deps.ensureProjectRegistered?.(ctx.cwd, deps.db);
				const workspaceIdentitySet = resolveWorkspaceIdentitySet(
					deps.db,
					projectIdentity,
				);
				const expandedWorkspace = expandWorkspaceIdentitySetWithAliases(
					deps.db,
					workspaceIdentitySet.identities,
				);
				const workspaceVisibleIdentities =
					workspaceIdentitySet.identities.length > 1
						? expandedWorkspace.expandedIdentities
						: workspaceIdentitySet.identities;
				const targetIdentityForStoredPath = (rawProjectPath: string) =>
					workspaceIdentitySet.identities.length > 1
						? (resolveStoredPathWorkspaceIdentity(
								rawProjectPath,
								workspaceIdentitySet.identities,
								expandedWorkspace.canonicalIdentityByStoredPath,
							) ?? normalizeStoredProjectPath(rawProjectPath))
						: normalizeStoredProjectPath(rawProjectPath);
				// The workspace's share-category policy matches the render path.
				// null means there is no workspace filter; a workspaced caller gets
				// an explicit list where [] shares no foreign categories.
				const toolShareCategories =
					workspaceIdentitySet.identities.length > 1
						? resolveWorkspaceShareCategories(deps.db, projectIdentity)
						: null;
				// Visibility is the READ contract: own memories are visible in every
				// category, while foreign workspace memories are visible only in
				// categories the workspace explicitly shares. Mutations by primary
				// agents use memoryOwnedByTool below so shared visibility never
				// grants write access to another project.
				const memoryVisibleToTool = (memory: Memory): boolean => {
					if (workspaceIdentitySet.identities.length <= 1) {
						return storedPathBelongsToIdentity(
							memory.projectPath,
							projectIdentity,
						);
					}
					if (
						!storedPathBelongsToWorkspace(
							memory.projectPath,
							workspaceIdentitySet.identities,
							workspaceVisibleIdentities,
							expandedWorkspace.canonicalIdentityByStoredPath,
						)
					) {
						return false;
					}
					const isOwn =
						targetIdentityForStoredPath(memory.projectPath) === projectIdentity;
					if (isOwn) return true;
					return toolShareCategories?.includes(memory.category) ?? false;
				};
				const memoryOwnedByTool = (memory: Memory): boolean =>
					workspaceIdentitySet.identities.length > 1
						? targetIdentityForStoredPath(memory.projectPath) ===
							projectIdentity
						: storedPathBelongsToIdentity(memory.projectPath, projectIdentity);
				// Hard-hidden and rejected rows return uniform absence on every
				// agent surface — including as MUTATION targets: updating a
				// policy-hidden memory would mint a fresh current revision
				// without the old revision's disposition and resurface the
				// content. One decision covers every id-based branch (update,
				// merge, archive) for every agent (parity with OpenCode).
				const memoryPolicyDeniesToolTarget = (
					memoryIds: readonly number[],
				): boolean => {
					const rows = readMemoryPolicyRows(deps.db, memoryIds);
					return memoryIds.some(
						(id) =>
							!decideMemoryPolicy(rows.get(id), "explicit_search").eligible,
					);
				};
				const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
				if (
					snapshot
						? !snapshot.features.memoryEnabled
						: deps.memoryEnabled === false
				) {
					return err("Cross-session memory is disabled for this project.");
				}

				if (params.action === "write") {
					const content = params.content?.trim();
					if (!content)
						return err("Error: 'content' is required when action is 'write'.");

					const rawCategory = params.category;
					if (!rawCategory) {
						return err("Error: 'category' is required when action is 'write'.");
					}

					const normalizedHash = computeNormalizedHash(content);
					const writeRequest = {
						projectPath: projectIdentity,
						category: rawCategory,
						normalizedHash,
						content,
					};
					const writeIdentity = claimOperationIdentity("write", writeRequest);
					if (writeIdentity && hasMemoryClaimsCompatSchema(deps.db)) {
						const envelope = toClaimOperationEnvelope(writeIdentity);
						const replay = readMemoryClaimOperationResult<{
							memoryId: number;
							duplicate?: boolean;
							denied?: boolean;
						}>(deps.db, envelope);
						if (replay) {
							if (replay.result.denied) {
								return err(
									`Error: Memory could not be saved in ${rawCategory}.`,
								);
							}
							// The outcome was stored while the memory was visible;
							// a quarantine/rejection since then must not leak the
							// id through a committed-but-unacked retry. Same
							// uniform refusal as a fresh denial.
							if (memoryPolicyDeniesToolTarget([replay.result.memoryId])) {
								return err(
									`Error: Memory could not be saved in ${rawCategory}.`,
								);
							}
							return ok(
								replay.result.duplicate
									? `Memory already exists [ID: ${replay.result.memoryId}] in ${rawCategory} (seen count incremented).`
									: `Saved memory [ID: ${replay.result.memoryId}] in ${rawCategory}.`,
							);
						}
						// The duplicate short-circuit runs inside the envelope so a
						// committed-but-unacked write replays its stored outcome
						// instead of re-bumping seen_count; the insert runs under
						// its own storage-generated key.
						const outcome = deps.db
							.transaction(() =>
								withMemoryClaimGenerationContextInCurrentTransaction(
									deps.db,
									() =>
										runMemoryClaimOperationInCurrentTransaction<{
											memoryId: number;
											duplicate: boolean;
											denied?: boolean;
										}>(deps.db, envelope, () => {
											const existing = getMemoryByHash(
												deps.db,
												projectIdentity,
												rawCategory,
												normalizedHash,
											);
											if (existing) {
												// A policy-hidden duplicate returns uniform
												// refusal: the UNIQUE row cannot be
												// re-inserted, and both its id and its seen
												// count stay undisclosed and untouched.
												if (memoryPolicyDeniesToolTarget([existing.id])) {
													return {
														result: {
															memoryId: existing.id,
															duplicate: true,
															denied: true,
														},
														effects: [],
													};
												}
												updateMemorySeenCount(deps.db, existing.id);
												return {
													result: { memoryId: existing.id, duplicate: true },
													effects: [],
												};
											}
											const inserted = insertMemoryIdempotent(deps.db, {
												projectPath: projectIdentity,
												category: rawCategory,
												content,
												sourceSessionId: sessionId,
												sourceType: dreamerAllowed ? "dreamer" : "agent",
											});
											if (!inserted.inserted) {
												// Raced duplicate recovered from the unique
												// constraint: same policy-before-mutation
												// contract as the pre-check branch above — a
												// hidden row's id and seen count stay
												// undisclosed and untouched.
												if (
													memoryPolicyDeniesToolTarget([inserted.memory.id])
												) {
													return {
														result: {
															memoryId: inserted.memory.id,
															duplicate: true,
															denied: true,
														},
														effects: [],
													};
												}
												updateMemorySeenCount(deps.db, inserted.memory.id);
											}
											return {
												result: {
													memoryId: inserted.memory.id,
													duplicate: !inserted.inserted,
												},
												effects: [],
											};
										}),
								),
							)
							.immediate();
						if (outcome.result.denied) {
							return err(`Error: Memory could not be saved in ${rawCategory}.`);
						}
						if (outcome.result.duplicate) {
							return ok(
								`Memory already exists [ID: ${outcome.result.memoryId}] in ${rawCategory} (seen count incremented).`,
							);
						}
						if (!outcome.replayed) {
							queueEmbedding({
								deps,
								projectIdentity,
								memoryId: outcome.result.memoryId,
								content,
							});
						}
						return ok(
							`Saved memory [ID: ${outcome.result.memoryId}] in ${rawCategory}.`,
						);
					}

					const existing = getMemoryByHash(
						deps.db,
						projectIdentity,
						rawCategory,
						normalizedHash,
					);
					if (existing) {
						if (memoryPolicyDeniesToolTarget([existing.id])) {
							return err(`Error: Memory could not be saved in ${rawCategory}.`);
						}
						updateMemorySeenCount(deps.db, existing.id);
						return ok(
							`Memory already exists [ID: ${existing.id}] in ${rawCategory} (seen count incremented).`,
						);
					}

					const insertResult = insertMemoryIdempotent(
						deps.db,
						{
							projectPath: projectIdentity,
							category: rawCategory,
							content,
							sourceSessionId: sessionId,
							sourceType: dreamerAllowed ? "dreamer" : "agent",
						},
						writeIdentity,
					);
					if (!insertResult.inserted) {
						// The recovery is non-mutating, so the policy decision runs
						// before the raced row is touched: a hidden duplicate gets the
						// uniform refusal with its seen count intact.
						if (memoryPolicyDeniesToolTarget([insertResult.memory.id])) {
							return err(`Error: Memory could not be saved in ${rawCategory}.`);
						}
						updateMemorySeenCount(deps.db, insertResult.memory.id);
						return ok(
							`Memory already exists [ID: ${insertResult.memory.id}] in ${rawCategory} (seen count incremented).`,
						);
					}
					const memory = insertResult.memory;

					queueEmbedding({
						deps,
						projectIdentity,
						memoryId: memory.id,
						content,
					});
					// Do NOT invalidate the m[0]/m[1] cache here. An additive write is a
					// supersede-delta operation: it surfaces in m[1] via the maxMemoryId
					// watermark (renderM1 reads memories with id > cachedM0MaxMemoryId) on
					// the next cache-busting pass, WITHOUT busting m[0]. Clearing the cache
					// re-materialized m[0] for every session (the call was global over
					// session_meta), defeating the whole additive/non-additive split and
					// busting unrelated projects. Matches OpenCode's write path, which
					// likewise does no cache invalidation.
					return ok(`Saved memory [ID: ${memory.id}] in ${rawCategory}.`);
				}

				if (params.action === "list") {
					const limit = normalizeLimit(params.limit);
					const filtered = getMemoriesByProject(deps.db, projectIdentity);
					const category = params.category;
					const filtered2 = category
						? filtered.filter((m) => m.category === category)
						: filtered;
					// The explicit-surface decision applies before the limit:
					// hard-hidden rows get uniform absence; sub-verified rows
					// keep sanitized trust labels. Same gate as the OpenCode
					// tool so neither harness is a laxer read path.
					const policyFiltered = filterMemoriesByPolicy(
						deps.db,
						filtered2,
						"explicit_search",
					);
					return ok(
						formatMemoryList(
							policyFiltered.memories.slice(0, limit),
							policyFiltered.labels,
						),
					);
				}

				if (params.action === "get") {
					const getIds = params.ids;
					if (
						!getIds ||
						getIds.length === 0 ||
						!getIds.every(Number.isInteger)
					) {
						return err(
							"Error: 'ids' must contain at least one integer memory ID when action is 'get'.",
						);
					}
					if (getIds.length > GET_MAX_IDS) {
						return err(
							`Error: 'ids' must contain at most ${GET_MAX_IDS} memory IDs when action is 'get' (got ${getIds.length}).`,
						);
					}
					// De-dupe while preserving first-seen order so the output lists
					// each requested id exactly once and never reflects a row twice.
					const uniqueIds = [...new Set(getIds)];
					const fetched = getMemoriesByIds(deps.db, uniqueIds);
					const policyFiltered = filterMemoriesByPolicy(
						deps.db,
						fetched.filter((memory) => memoryVisibleToTool(memory)),
						"explicit_search",
					);
					const memoriesById = new Map<number, Memory>(
						policyFiltered.memories.map((memory) => [memory.id, memory]),
					);
					return ok(
						formatGetOutput({
							requestedIds: uniqueIds,
							memoriesById,
							policyLabels: policyFiltered.labels,
						}),
					);
				}

				if (params.action === "update") {
					const updateIds = params.ids;
					if (updateIds?.length !== 1 || !updateIds.every(Number.isInteger)) {
						return err(
							"Error: 'ids' must contain exactly one integer memory ID when action is 'update'.",
						);
					}
					const updateId = updateIds[0];
					const content = params.content?.trim();
					if (!content) {
						return err("Error: 'content' is required when action is 'update'.");
					}

					const normalizedHash = computeNormalizedHash(content);
					const updateIdentity = claimOperationIdentity(`update:${updateId}`, {
						id: updateId,
						content,
						normalizedHash,
					});
					// Replay before live-row validation: a committed-but-unacked
					// update must return its stored result even after the target
					// row was archived or removed. The stored result carries the
					// category so the message never reads the live row.
					if (updateIdentity && hasMemoryClaimsCompatSchema(deps.db)) {
						const replay = readMemoryClaimOperationResult<{
							memoryId: number;
							category: string;
						}>(deps.db, toClaimOperationEnvelope(updateIdentity));
						if (replay) {
							// The stored outcome predates any later
							// quarantine/rejection: refuse instead of
							// re-disclosing a now-hidden id on retry.
							if (memoryPolicyDeniesToolTarget([replay.result.memoryId])) {
								return err(`Error: Memory with ID ${updateId} was not found.`);
							}
							return ok(
								`Updated memory [ID: ${replay.result.memoryId}] in ${replay.result.category}.`,
							);
						}
					}

					const memory = getMemoryById(deps.db, updateId);
					const updateAllowed = memory
						? dreamerAllowed
							? memoryVisibleToTool(memory)
							: memoryOwnedByTool(memory)
						: false;
					if (
						!memory ||
						!updateAllowed ||
						memoryPolicyDeniesToolTarget([updateId])
					) {
						return err(`Error: Memory with ID ${updateId} was not found.`);
					}
					if (!dreamerAllowed && !isPrimaryMutableMemory(memory)) {
						return err(inactiveMemoryError(updateId, "updating"));
					}

					const targetIdentity = targetIdentityForStoredPath(
						memory.projectPath,
					);
					const duplicate = getMemoryByHash(
						deps.db,
						targetIdentity,
						memory.category,
						normalizedHash,
					);
					if (duplicate && duplicate.id !== memory.id) {
						// Never disclose a policy-hidden duplicate's id; the UNIQUE
						// constraint forces a refusal either way.
						return err(
							memoryPolicyDeniesToolTarget([duplicate.id])
								? "Error: Memory content already exists; choose different content."
								: `Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`,
						);
					}

					let replayed = false;
					let deniedInTransaction = false;
					deps.db
						.transaction(() =>
							withMemoryClaimGenerationContextInCurrentTransaction(
								deps.db,
								() => {
									// The visibility snapshot above ran outside this
									// transaction: another process can quarantine or
									// reject the target in the gap, and appending a
									// successor revision would strip the hidden
									// revision's disposition. Re-evaluate while
									// holding the write lock.
									if (memoryPolicyDeniesToolTarget([memory.id])) {
										deniedInTransaction = true;
										return;
									}
									if (updateIdentity && hasMemoryClaimsCompatSchema(deps.db)) {
										// The tool owns the envelope so the stored
										// result carries the category; the storage
										// update runs under its own generated key.
										const outcome = runMemoryClaimOperationInCurrentTransaction(
											deps.db,
											toClaimOperationEnvelope(updateIdentity),
											() => {
												updateMemoryContentInCurrentTransaction(
													deps.db,
													memory,
													content,
													normalizedHash,
												);
												queueMemoryMutation(deps.db, {
													projectPath: targetIdentity,
													mutationType: "update",
													targetMemoryId: memory.id,
													category: memory.category,
													newContent: content,
												});
												return {
													result: {
														memoryId: memory.id,
														category: memory.category,
													},
													effects: [],
												};
											},
										);
										replayed = outcome.replayed;
										return;
									}
									replayed = updateMemoryContentInCurrentTransaction(
										deps.db,
										memory,
										content,
										normalizedHash,
										updateIdentity,
									);
									if (!replayed) {
										queueMemoryMutation(deps.db, {
											projectPath: targetIdentity,
											mutationType: "update",
											targetMemoryId: memory.id,
											category: memory.category,
											newContent: content,
										});
									}
								},
							),
						)
						.immediate();
					if (deniedInTransaction) {
						return err(`Error: Memory with ID ${updateId} was not found.`);
					}
					if (replayed) {
						return ok(
							`Updated memory [ID: ${memory.id}] in ${memory.category}.`,
						);
					}
					queueEmbedding({
						deps,
						projectIdentity: targetIdentity,
						memoryId: memory.id,
						content,
					});
					return ok(`Updated memory [ID: ${memory.id}] in ${memory.category}.`);
				}

				if (params.action === "merge") {
					const ids = params.ids;
					if (!ids || ids.length < 2 || !ids.every(Number.isInteger)) {
						return err(
							"Error: 'ids' must include at least two integer memory IDs when action is 'merge'.",
						);
					}
					if (new Set(ids).size !== ids.length) {
						return err(
							"Error: 'ids' must include at least two distinct memory IDs when action is 'merge'.",
						);
					}

					const content = params.content?.trim();
					if (!content) {
						return err("Error: 'content' is required when action is 'merge'.");
					}

					const normalizedHash = computeNormalizedHash(content);
					// The identity digest uses only source-independent inputs (the
					// requested category, not one derived from a live source row),
					// so a retry can reconstruct it after every source is deleted.
					// The `merge:2` key suffix versions the digest shape: an
					// envelope recorded under the old `merge` key carries the old
					// digest, and probing it with the new digest would throw
					// ClaimOperationKeyReuseError instead of replaying.
					const mergeIdentity = claimOperationIdentity("merge:2", {
						ids,
						content,
						requestedCategory: params.category ?? null,
						projectIdentity,
					});
					// Replay before the source-existence and category checks: a
					// source deleted between attempts must not turn a
					// committed-but-unacked merge retry into a not-found or
					// category error. The stored result carries the category so
					// the message never depends on the live sources.
					if (mergeIdentity && hasMemoryClaimsCompatSchema(deps.db)) {
						const replay = readMemoryClaimOperationResult<{
							memoryId: number;
							category: string;
						}>(deps.db, toClaimOperationEnvelope(mergeIdentity));
						if (replay) {
							// The stored outcome predates any later
							// quarantine/rejection: refuse instead of
							// re-disclosing a now-hidden id on retry.
							if (memoryPolicyDeniesToolTarget([replay.result.memoryId])) {
								return err(
									"Error: One or more source memories were not found.",
								);
							}
							const supersededIds = ids.filter(
								(id) => id !== replay.result.memoryId,
							);
							return ok(
								`Merged memories [${ids.join(", ")}] into canonical memory [ID: ${replay.result.memoryId}] in ${replay.result.category}; superseded [${supersededIds.join(", ")}].`,
							);
						}
					}
					const sourceMemories = ids
						.map((id) => getMemoryById(deps.db, id))
						.filter((memory): memory is Memory => Boolean(memory));
					const requestedCategoryTyped: MemoryCategory | undefined =
						params.category;
					const category =
						requestedCategoryTyped ?? sourceMemories[0]?.category;
					if (!category) {
						// An unresolvable category usually means the sources are
						// gone (it falls back to sourceMemories[0]); report the
						// real problem instead of a misleading category error.
						return err(
							sourceMemories.length !== ids.length
								? "Error: One or more source memories were not found."
								: "Error: A valid category is required when action is 'merge'.",
						);
					}
					if (sourceMemories.length !== ids.length) {
						return err("Error: One or more source memories were not found.");
					}
					if (memoryPolicyDeniesToolTarget(ids)) {
						return err("Error: One or more source memories were not found.");
					}

					// Cross-identity consolidation is a DREAMER-ONLY capability: each
					// source is superseded under ITS OWN project identity with a
					// per-project supersede-delta row (see the supersede loop below),
					// so every affected project's m[1] reconciles correctly. But
					// `merge` is in the primary action set too, and a primary agent
					// must not reach into ANOTHER project's memories — mirror
					// update/archive ownership (parity with OpenCode).
					if (!dreamerAllowed) {
						const foreign = sourceMemories.find(
							(memory) => !memoryOwnedByTool(memory),
						);
						if (foreign) {
							return err(`Error: Memory with ID ${foreign.id} was not found.`);
						}
						const inactive = sourceMemories.find(
							(memory) => !isPrimaryMutableMemory(memory),
						);
						if (inactive) {
							return err(inactiveMemoryError(inactive.id, "merging"));
						}
					} else if (workspaceIdentitySet.identities.length > 1) {
						// The dreamer keeps cross-PROJECT merge power (#5971) OUTSIDE a
						// workspace, but INSIDE a workspace per-category sharing is the
						// user's explicit privacy boundary the dreamer honors too: a
						// foreign member's memory in a non-shared category is off-limits.
						// memoryVisibleToTool already encodes own→true,
						// foreign-shared→true, else→false. (Parity with OpenCode D1.)
						const blocked = sourceMemories.find(
							(memory) => !memoryVisibleToTool(memory),
						);
						if (blocked) {
							return err(
								`Error: Memory with ID ${blocked.id} is in a category not shared with this workspace member and cannot be merged.`,
							);
						}
					}

					// A fact has exactly one category. If sources span categories they
					// are NOT genuine duplicates — one is miscategorized; archive the
					// redundant one instead. Merging across categories silently destroys
					// a distinct fact, so reject it structurally (not a prompt rule).
					const sourceCategories = new Set(
						sourceMemories.map((memory) => memory.category),
					);
					if (sourceCategories.size > 1) {
						return err(
							`Error: Cannot merge memories from different categories (${[...sourceCategories].join(", ")}). If they are genuine duplicates, one is miscategorized — archive the redundant one instead of merging across categories.`,
						);
					}

					// Aggregate stats from all source memories.
					const mergedSeenCount = sourceMemories.reduce(
						(sum, memory) => sum + memory.seenCount,
						0,
					);
					const mergedRetrievalCount = sourceMemories.reduce(
						(sum, memory) => sum + memory.retrievalCount,
						0,
					);
					// `mergedFrom` is JSON-stringified in the DB. Flatten any prior
					// merge chains so the lineage stays accurate when merging
					// already-merged memories. Mirrors OpenCode's parity construction
					// at packages/plugin/src/tools/ctx-memory/tools.ts:381-405.
					const mergedFromIds = Array.from(
						new Set(
							sourceMemories.flatMap((memory) => {
								let parsed: unknown[] = [];
								try {
									parsed = memory.mergedFrom
										? JSON.parse(memory.mergedFrom)
										: [];
								} catch {
									parsed = [];
								}
								const priorIds = Array.isArray(parsed)
									? parsed.filter(
											(value): value is number => typeof value === "number",
										)
									: [];
								return [memory.id, ...priorIds];
							}),
						),
					).sort((left, right) => left - right);
					const mergedFrom = JSON.stringify(mergedFromIds);
					const mergedStatus: "active" | "permanent" = sourceMemories.some(
						(memory) => memory.status === "permanent",
					)
						? "permanent"
						: "active";

					let canonicalMemoryId: number | null = null;
					let mergeConflict: string | null = null;
					let mergeReplayed = false;
					deps.db
						.transaction(() =>
							withMemoryClaimGenerationContextInCurrentTransaction(
								deps.db,
								() => {
									// The source-visibility snapshot ran outside this
									// transaction: re-evaluate every source while
									// holding the write lock so a target hidden in
									// the gap is neither superseded nor resurfaced
									// through the merged successor.
									if (memoryPolicyDeniesToolTarget(ids)) {
										mergeConflict =
											"Error: One or more source memories were not found.";
										return;
									}
									if (mergeIdentity && hasMemoryClaimsCompatSchema(deps.db)) {
										const replay = readMemoryClaimOperationResult<{
											memoryId: number;
											category: string;
										}>(deps.db, toClaimOperationEnvelope(mergeIdentity));
										if (replay) {
											canonicalMemoryId = replay.result.memoryId;
											mergeReplayed = true;
											return;
										}
									}
									const lockedDuplicate = getMemoryByHash(
										deps.db,
										projectIdentity,
										category,
										normalizedHash,
									);
									const canonicalExisting =
										lockedDuplicate && ids.includes(lockedDuplicate.id)
											? lockedDuplicate
											: null;
									if (lockedDuplicate && !canonicalExisting) {
										mergeConflict = memoryPolicyDeniesToolTarget([
											lockedDuplicate.id,
										])
											? "Error: Memory content already exists; choose different content."
											: `Error: Memory content already exists as ID ${lockedDuplicate.id}; update or archive existing duplicates instead.`;
										return;
									}
									let canonicalMemory: Memory;
									let canonicalContentChanged = false;
									if (canonicalExisting) {
										// One of the source memories already has the merged content.
										// Update it in place to absorb stats from the others.
										canonicalMemory = canonicalExisting;
										canonicalContentChanged =
											canonicalMemory.content !== content ||
											canonicalMemory.normalizedHash !== normalizedHash;
										if (canonicalContentChanged) {
											// Already inside the merge's transaction and claim
											// generation context; the standalone updateMemoryContent
											// would open a nested claims write transaction. The merge
											// replay row is recorded by the tool-owned envelope below
											// under mergeIdentity, so the content update carries no
											// identity of its own. Parity with OpenCode.
											updateMemoryContentInCurrentTransaction(
												deps.db,
												canonicalMemory,
												content,
												normalizedHash,
											);
										}
									} else {
										// Insert a fresh canonical memory with the merged content.
										// Idempotent insert absorbs a unique-constraint race with a
										// concurrent writer of the same tuple (parity with OpenCode);
										// no identity — the merge envelope is tool-owned below.
										canonicalMemory = insertMemoryIdempotent(deps.db, {
											projectPath: projectIdentity,
											category,
											content,
											sourceSessionId: sessionId,
											sourceType: dreamerAllowed ? "dreamer" : "agent",
										}).memory;
									}

									mergeMemoryStats(
										deps.db,
										canonicalMemory.id,
										mergedSeenCount,
										mergedRetrievalCount,
										mergedFrom,
										mergedStatus,
									);

									for (const memory of sourceMemories) {
										if (memory.id === canonicalMemory.id) {
											continue;
										}
										supersededMemory(deps.db, memory.id, canonicalMemory.id);
										queueMemoryMutation(deps.db, {
											// Normalize the stored path to the resolved identity
											// before queueing — the render-side mutation-log reader
											// matches exact project_path, and OpenCode + dashboard
											// both normalize first. A legacy raw filesystem path here
											// would write a row that normalized git:/dir: sessions
											// never read (the supersede delta would silently vanish).
											projectPath: normalizeStoredProjectPath(
												memory.projectPath,
											),
											mutationType: "superseded",
											targetMemoryId: memory.id,
											supersededById: canonicalMemory.id,
										});
									}

									if (canonicalExisting && canonicalContentChanged) {
										queueMemoryMutation(deps.db, {
											projectPath: normalizeStoredProjectPath(
												canonicalMemory.projectPath,
											),
											mutationType: "update",
											targetMemoryId: canonicalMemory.id,
											category,
											newContent: content,
										});
									}

									// The tool owns the merge envelope so the stored result
									// carries the category the replay message needs; the
									// storage-layer writes above run under their own
									// generated keys.
									if (mergeIdentity && hasMemoryClaimsCompatSchema(deps.db)) {
										runMemoryClaimOperationInCurrentTransaction(
											deps.db,
											toClaimOperationEnvelope(mergeIdentity),
											() => ({
												result: { memoryId: canonicalMemory.id, category },
												effects: [],
											}),
										);
									}
									canonicalMemoryId = canonicalMemory.id;
								},
							),
						)
						.immediate();

					if (mergeConflict || canonicalMemoryId === null) {
						return err(mergeConflict ?? "Error: Failed to merge memories.");
					}
					if (!mergeReplayed) {
						queueEmbedding({
							deps,
							projectIdentity,
							memoryId: canonicalMemoryId,
							content,
						});
					}
					const supersededIds = sourceMemories
						.map((memory) => memory.id)
						.filter((id) => id !== canonicalMemoryId);
					return ok(
						`Merged memories [${ids.join(", ")}] into canonical memory [ID: ${canonicalMemoryId}] in ${category}; superseded [${supersededIds.join(", ")}].`,
					);
				}

				if (params.action === "archive") {
					const rawArchiveIds = params.ids;
					if (
						!rawArchiveIds ||
						rawArchiveIds.length === 0 ||
						!rawArchiveIds.every(Number.isInteger)
					) {
						return err(
							"Error: 'ids' must contain at least one integer memory ID when action is 'archive'.",
						);
					}
					// De-dupe (first-seen order): `ids:[42,42]` archives once.
					const archiveIds = [...new Set(rawArchiveIds)];
					// Normalized once so the identity digest, stored reason, and
					// reply suffix agree: a whitespace-only reason is no reason.
					const trimmedReason = params.reason?.trim() || undefined;
					const archiveIdentity = (
						memoryId: number,
					): MemoryClaimOperationIdentity | undefined =>
						claimOperationIdentity(
							`archive:${memoryId}`,
							trimmedReason
								? { id: memoryId, reason: trimmedReason }
								: { id: memoryId, status: "archived" },
						);
					const archiveReplay =
						hasMemoryClaimsCompatSchema(deps.db) &&
						archiveIds.every((memoryId) => {
							const identity = archiveIdentity(memoryId);
							return (
								identity !== undefined &&
								readMemoryClaimOperationResult(
									deps.db,
									toClaimOperationEnvelope(identity),
								) !== null
							);
						});
					if (archiveReplay) {
						const reasonSuffix = trimmedReason ? ` (${trimmedReason})` : "";
						const idList = archiveIds.join(", ");
						const plural = archiveIds.length > 1 ? "memories" : "memory";
						return ok(`Archived ${plural} [ID: ${idList}]${reasonSuffix}.`);
					}
					// Validate the whole batch BEFORE mutating so a typo'd id can't
					// half-archive a batch (all-or-nothing, matching the transaction).
					for (const memoryId of archiveIds) {
						const memory = getMemoryById(deps.db, memoryId);
						const archiveAllowed = memory
							? dreamerAllowed
								? memoryVisibleToTool(memory)
								: memoryOwnedByTool(memory)
							: false;
						if (
							!memory ||
							!archiveAllowed ||
							memoryPolicyDeniesToolTarget([memoryId])
						) {
							return err(`Error: Memory with ID ${memoryId} was not found.`);
						}
						if (!dreamerAllowed && !isPrimaryMutableMemory(memory)) {
							// Match update/merge: once a primary caller archived or
							// superseded a memory, re-archiving it should stop with the same
							// friendly inactive-memory error instead of rewriting it.
							return err(inactiveMemoryError(memoryId, "archiving"));
						}
					}
					const targets = archiveIds.map((memoryId) => {
						const memory = getMemoryById(deps.db, memoryId);
						if (!memory)
							throw new Error(`validated memory ${memoryId} disappeared`);
						return {
							memoryId,
							projectIdentity: targetIdentityForStoredPath(memory.projectPath),
						};
					});
					let archiveDeniedInTransaction = false;
					deps.db
						.transaction(() =>
							withMemoryClaimGenerationContextInCurrentTransaction(
								deps.db,
								() => {
									// The per-target visibility loop above ran outside
									// this transaction: re-evaluate the whole batch
									// while holding the write lock so a target hidden
									// in the gap is not mutated (all-or-nothing,
									// matching the batch below).
									if (
										memoryPolicyDeniesToolTarget(
											targets.map((target) => target.memoryId),
										)
									) {
										archiveDeniedInTransaction = true;
										return;
									}
									for (const target of targets) {
										const replayed = archiveMemory(
											deps.db,
											target.memoryId,
											trimmedReason,
											archiveIdentity(target.memoryId),
										);
										if (!replayed) {
											queueMemoryMutation(deps.db, {
												projectPath: target.projectIdentity,
												mutationType: "archive",
												targetMemoryId: target.memoryId,
											});
										}
									}
								},
							),
						)
						.immediate();
					if (archiveDeniedInTransaction) {
						return err("Error: One or more memories were not found.");
					}
					const reasonSuffix = trimmedReason ? ` (${trimmedReason})` : "";
					const idList = archiveIds.join(", ");
					const plural = archiveIds.length > 1 ? "memories" : "memory";
					return ok(`Archived ${plural} [ID: ${idList}]${reasonSuffix}.`);
				}

				return err("Error: Unknown action.");
			} catch (error) {
				// A digest mismatch on a re-presented tool-call id is caller
				// error; report it as a tool result instead of throwing out
				// of execute().
				if (error instanceof ClaimOperationKeyReuseError) {
					return err(
						"Error: this tool call id was already committed with different arguments. Retry as a new call.",
					);
				}
				throw error;
			}
		},
	};
}
