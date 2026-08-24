import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { DREAMER_AGENT } from "../../agents/dreamer";
import { SIDEKICK_AGENT } from "../../agents/sidekick";
import { getAuthorityManagedMarker } from "../../features/magic-context/context-authority";
import {
    archiveMemory,
    CATEGORY_PRIORITY,
    getMemoriesByIds,
    getMemoriesByProject,
    getMemoryByHash,
    getMemoryById,
    insertMemoryIdempotent,
    type Memory,
    type MemoryCategory,
    mergeMemoryStats,
    saveEmbeddingIfHashMatches,
    supersededMemory,
    updateMemorySeenCount,
    V2_MEMORY_CATEGORIES,
} from "../../features/magic-context/memory";
import {
    embedTextForProject,
    enqueueShadowEmbeddingItems,
    getProjectEmbeddingSnapshot,
} from "../../features/magic-context/memory/embedding";
import { invalidateMemory } from "../../features/magic-context/memory/embedding-cache";
import { computeNormalizedHash } from "../../features/magic-context/memory/normalize-hash";
import {
    decideMemoryPolicy,
    exactMemoryContentDigests,
    filterMemoriesByPolicy,
    hasClaimEffectivePolicy,
    memoriesEligibleForEmbedding,
    readMemoryPolicyRows,
} from "../../features/magic-context/memory/storage-claim-visibility";
import { sha256Utf8Hex } from "../../features/magic-context/memory/storage-claims";
import {
    hasMemoryClassifiedAtColumn,
    hasMemoryShareableColumn,
    type MemoryClaimOperationIdentity,
} from "../../features/magic-context/memory/storage-memory";
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
} from "../../features/magic-context/memory/storage-memory-claims";
import {
    normalizeStoredProjectPath,
    queueMemoryMutation,
    storedPathBelongsToIdentity,
} from "../../features/magic-context/storage";
import {
    expandWorkspaceIdentitySetWithAliases,
    resolveStoredPathWorkspaceIdentity,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
    storedPathBelongsToWorkspace,
} from "../../features/magic-context/workspaces";
import {
    isRustAuthorityDrainingError,
    toolCallIdFromContext,
} from "../../plugin/rust-tool-backends";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { CTX_MEMORY_DESCRIPTION, CTX_MEMORY_TOOL_NAME, DEFAULT_SEARCH_LIMIT } from "./constants";
import {
    CTX_MEMORY_ACTIONS,
    CTX_MEMORY_DREAMER_ACTIONS,
    type CtxMemoryAction,
    type CtxMemoryArgs,
    type CtxMemoryToolDeps,
} from "./types";

export { CTX_MEMORY_LIGHT_DESCRIPTION } from "../light-descriptions";

const MEMORY_CATEGORIES = new Set<string>(CATEGORY_PRIORITY);

function isMemoryCategory(value: string): value is MemoryCategory {
    return MEMORY_CATEGORIES.has(value);
}

function normalizeLimit(limit?: number): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return DEFAULT_SEARCH_LIMIT;
    }

    return Math.max(1, Math.floor(limit));
}

// When a caller omits `allowedActions`, fall back
// to the least-privileged set instead of the dreamer's full action list. The
// only production caller (`tool-registry.ts`) passes the primary set
// (`CTX_MEMORY_ACTIONS`) explicitly, and dreamer child sessions are gated by the
// runtime `toolContext.agent === DREAMER_AGENT` check below — they bypass
// `allowedActions` entirely. A future caller that forgets the field would
// previously have inadvertently let primary agents run the dreamer-only `list`;
// fail-closed default prevents that class of regression.
function getAllowedActions(deps: CtxMemoryToolDeps): [CtxMemoryAction, ...CtxMemoryAction[]] {
    const allowed = deps.allowedActions?.length ? deps.allowedActions : CTX_MEMORY_ACTIONS;
    return [...allowed] as [CtxMemoryAction, ...CtxMemoryAction[]];
}

function normalizeCategory(category?: string): string | undefined {
    const trimmed = category?.trim();
    return trimmed ? trimmed : undefined;
}

function memoryAuthorityRefusal(args: CtxMemoryArgs): string {
    const readiness = "Rust memory authority is not ready.";
    if (
        (args.action === "write" || args.action === "update" || args.action === "merge") &&
        typeof args.content === "string"
    ) {
        return `Error: ${readiness} Write REFUSED and NOT saved; RESEND after authority is ready.\nContent to resend:\n${args.content}`;
    }
    return `Error: ${readiness} Request REFUSED and NOT applied; RESEND after authority is ready.`;
}

function moduleMemoryText(response: unknown, args: CtxMemoryArgs): string | null {
    let value = response;
    if (value !== null && typeof value === "object" && "result" in value) {
        value = (value as { result?: unknown }).result;
    }
    if (isRustAuthorityDrainingError(value)) {
        return memoryAuthorityRefusal(args);
    }
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.ok === false || record.error || typeof record.message === "string") {
            const detail = record.error ?? record.message ?? "module rejected ctx_memory";
            const message =
                detail !== null && typeof detail === "object" && "message" in detail
                    ? String((detail as { message?: unknown }).message)
                    : String(detail);
            return `Error: ${message}`;
        }
        if (Array.isArray(record.content)) {
            const text = record.content.find(
                (item): item is { text: string } =>
                    item !== null &&
                    typeof item === "object" &&
                    typeof (item as { text?: unknown }).text === "string",
            )?.text;
            if (text) return text;
        }
    }
    return null;
}

function formatMemoryList(memories: Memory[], policyLabels?: Map<number, string>): string {
    if (memories.length === 0) {
        return "No active memories found.";
    }

    const rows = memories.map((memory) => ({
        id: String(memory.id),
        category: memory.category,
        status: memory.status,
        verification: memory.verificationStatus,
        trust: policyLabels?.get(memory.id) ?? "",
        updated: new Date(memory.updatedAt).toISOString(),
        content: memory.content.replace(/\s+/g, " ").trim(),
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
        id: Math.max(headers.id.length, ...rows.map((row) => row.id.length)),
        category: Math.max(headers.category.length, ...rows.map((row) => row.category.length)),
        status: Math.max(headers.status.length, ...rows.map((row) => row.status.length)),
        verification: Math.max(
            headers.verification.length,
            ...rows.map((row) => row.verification.length),
        ),
        trust: Math.max(headers.trust.length, ...rows.map((row) => row.trust.length)),
        updated: Math.max(headers.updated.length, ...rows.map((row) => row.updated.length)),
    };
    const formatRow = (row: (typeof rows)[number] | typeof headers) =>
        [
            row.id.padEnd(widths.id),
            row.category.padEnd(widths.category),
            row.status.padEnd(widths.status),
            row.verification.padEnd(widths.verification),
            row.trust.padEnd(widths.trust),
            row.updated.padEnd(widths.updated),
            row.content,
        ].join(" | ");

    return [
        `Found ${rows.length} active ${rows.length === 1 ? "memory" : "memories"}:`,
        "",
        formatRow(headers),
        [
            "-".repeat(widths.id),
            "-".repeat(widths.category),
            "-".repeat(widths.status),
            "-".repeat(widths.verification),
            "-".repeat(widths.trust),
            "-".repeat(widths.updated),
            "-------",
        ].join("-+-"),
        ...rows.map(formatRow),
    ].join("\n");
}

function filterByCategory(memories: Memory[], category?: string): Memory[] {
    if (!category) {
        return memories;
    }

    return memories.filter((memory) => memory.category === category);
}

// Per-id not-found / not-visible wording. Sharing one message between the two
// states avoids an existence oracle for foreign memories — a caller that knows
// a memory is hidden by workspace share policy should not be able to
// distinguish "this id is foreign and not shared" from "this id does not
// exist" by reading the error text.
const GET_NOT_VISIBLE_MESSAGE = (id: number): string =>
    `id ${id}: not found or not visible from this project`;

const GET_MAX_IDS = 20;

function formatGetOutput(args: {
    requestedIds: number[];
    memoriesById: Map<number, Memory>;
    policyLabels?: Map<number, string>;
}): string {
    const parts: string[] = [];
    for (const id of args.requestedIds) {
        const memory = args.memoriesById.get(id);
        if (!memory) {
            parts.push(GET_NOT_VISIBLE_MESSAGE(id));
        } else {
            parts.push(formatMemoryList([memory], args.policyLabels));
        }
    }
    return parts.join("\n\n");
}

function queueMemoryEmbedding(args: {
    deps: CtxMemoryToolDeps;
    sessionId: string;
    projectPath: string;
    memoryId: number;
    content: string;
}): void {
    const snapshot = getProjectEmbeddingSnapshot(args.projectPath);
    if (!snapshot?.enabled) {
        return;
    }
    // Hard-hidden / rejected content never leaves the process, remote
    // embedding providers included.
    if (!memoriesEligibleForEmbedding(args.deps.db, [args.memoryId]).has(args.memoryId)) {
        return;
    }

    const normalizedHash = computeNormalizedHash(args.content);
    const contentDigest = sha256Utf8Hex(args.content);
    void (async () => {
        // The queued closure runs after an arbitrary delay: re-check
        // eligibility at the provider boundary and bind it to the exact bytes
        // this closure captured, so a quarantine/rejection or rewrite that
        // landed after enqueue cannot leak the content to the provider.
        if (!memoriesEligibleForEmbedding(args.deps.db, [args.memoryId]).has(args.memoryId)) {
            sessionLog(
                args.sessionId,
                `memory embedding skipped for memory ${args.memoryId}: no longer eligible at provider drain.`,
            );
            return;
        }
        if (
            exactMemoryContentDigests(args.deps.db, [args.memoryId]).get(args.memoryId) !==
            contentDigest
        ) {
            sessionLog(
                args.sessionId,
                `memory embedding skipped for memory ${args.memoryId}: content changed before the provider call.`,
            );
            return;
        }
        const result = await embedTextForProject(args.projectPath, args.content);
        if (!result) {
            sessionLog(
                args.sessionId,
                `memory embedding skipped for memory ${args.memoryId}: provider unavailable or embedding generation failed.`,
            );
            return;
        }

        const saved = saveEmbeddingIfHashMatches(
            args.deps.db,
            args.memoryId,
            result.vector,
            result.modelId,
            normalizedHash,
        );
        if (!saved) {
            sessionLog(
                args.sessionId,
                `memory embedding skipped for memory ${args.memoryId}: content changed before the embedding finished.`,
            );
            return;
        }

        enqueueShadowEmbeddingItems(args.projectPath, "memory", [String(args.memoryId)]);
        sessionLog(args.sessionId, `proactively embedded memory ${args.memoryId}.`);
    })().catch((error: unknown) => {
        sessionLog(args.sessionId, `memory embedding failed for memory ${args.memoryId}:`, error);
    });
}

function getValidatedCategory(category: string | undefined): MemoryCategory | null {
    const trimmedCategory = category?.trim();

    if (!trimmedCategory) {
        return null;
    }

    if (!isMemoryCategory(trimmedCategory)) {
        return null;
    }

    return trimmedCategory;
}

/**
 * Map native `module_row_id` values to TypeScript `memories.id` through the
 * mirror. The two id spaces are allowed to differ (`mirror_identity` records
 * the pairing per project), so a module-lane id must be translated before any
 * claims-database lookup. An id without an identity row maps to nothing: it
 * names a native row the mirror has not synced back, which has no claim or
 * policy row to consult yet. When the mirror table does not exist (module
 * authority was never prepared on this database) ids map to themselves.
 */
function translateModuleMemoryIds(
    db: Database,
    projectPath: string,
    ids: readonly number[],
): Map<number, number> {
    const hasMirror = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mirror_identity'")
        .get();
    if (!hasMirror) return new Map(ids.map((id) => [id, id]));
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
        .prepare(
            `SELECT module_row_id AS moduleId, context_row_id AS contextId
               FROM mirror_identity
              WHERE domain = 'memories' AND module_project = ?
                AND module_row_id IN (${placeholders})`,
        )
        .all(projectPath, ...ids) as Array<{ moduleId: number; contextId: number }>;
    return new Map(rows.map((row) => [row.moduleId, row.contextId]));
}

function getDisabledMessage(): string {
    return "Cross-session memory is disabled for this project.";
}

function getSourceType(deps: CtxMemoryToolDeps) {
    return deps.sourceType ?? "agent";
}

function requestRustMemorySync(deps: CtxMemoryToolDeps, sessionId: string): void {
    try {
        deps.rustToolBackends?.memorySync?.(sessionId);
    } catch (error) {
        sessionLog(sessionId, "rust memory sync trigger failed (ignored):", error);
    }
}

interface MemoryProjectPathRow {
    project_path: string;
}

function projectPathForMemoryId(db: CtxMemoryToolDeps["db"], id: number): string | null {
    const row = db.prepare("SELECT project_path FROM memories WHERE id = ?").get(id) as
        | MemoryProjectPathRow
        | undefined;
    return row?.project_path ?? null;
}

function projectIdentityForStoredPath(rawProjectPath: string): string {
    return normalizeStoredProjectPath(rawProjectPath);
}

function memoryBelongsToProject(memory: Memory, projectPath: string): boolean {
    return storedPathBelongsToIdentity(memory.projectPath, projectPath);
}

function isPrimaryMutableMemory(memory: Memory): boolean {
    return (
        (memory.status === "active" || memory.status === "permanent") &&
        memory.supersededByMemoryId === null
    );
}

function inactiveMemoryError(id: number, action: "updating" | "merging" | "archiving"): string {
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

function updateMemoryContentInCurrentTransaction(
    db: CtxMemoryToolDeps["db"],
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
                    producer: operationIdentity?.producer ?? "ctx-memory-opencode",
                    operationKey:
                        operationIdentity?.operationKey ?? `update:${crypto.randomUUID()}`,
                    requestDigest:
                        operationIdentity?.requestDigest ??
                        computeClaimRequestDigest({ id: memory.id, content, normalizedHash }),
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
    // Clear the classify marker so the changed fact is re-scored on the next
    // classify run (importance/scope were judged against the old content).
    if (hasMemoryClassifiedAtColumn(db)) {
        db.prepare("UPDATE memories SET classified_at = NULL WHERE id = ?").run(memory.id);
    }
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memory.id);
    invalidateMemory(memory.projectPath, memory.id);
    return false;
}

const ctxMemoryArgsShape = {
    // Keep the complete action argument shape available to execute(); it can reject
    // actions that are unsafe for the current agent once that agent is known. The
    // passthrough parser also retains extra arguments sent by older callers.
    action: tool.schema
        .enum([...CTX_MEMORY_DREAMER_ACTIONS])
        .optional()
        .describe("What to do: write, update, archive, merge, get, or list"),
    content: tool.schema
        .string()
        .optional()
        .describe("The memory text — one standalone fact (required for write, update, merge)"),
    category: tool.schema
        .enum([...V2_MEMORY_CATEGORIES])
        .optional()
        .describe("What kind of fact this is (required for write; optional merge override)"),
    ids: tool.schema
        .array(tool.schema.number())
        .optional()
        .describe(
            "Target memory id(s) from <project-memory>: update takes exactly one, archive one or more, merge two or more, get one to twenty",
        ),
    limit: tool.schema.number().optional().describe("Max results for list (default: 10)"),
    reason: tool.schema
        .string()
        .optional()
        .describe("Why the memory is being archived (optional, recommended)"),
};
const ctxMemoryArgsSchema = tool.schema.object(ctxMemoryArgsShape).passthrough();

function createCtxMemoryTool(deps: CtxMemoryToolDeps): ToolDefinition {
    const allowedActions = getAllowedActions(deps);

    return tool({
        description: CTX_MEMORY_DESCRIPTION,
        args: ctxMemoryArgsShape,
        async execute(rawArgs: CtxMemoryArgs, toolContext) {
            try {
                const parsedArgs = ctxMemoryArgsSchema.safeParse(rawArgs);
                let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxMemoryArgs;
                args = unwrapImitatedReducedArgs(args, ["action"], {
                    action: { type: "enum", values: CTX_MEMORY_DREAMER_ACTIONS },
                    content: "string",
                    category: { type: "enum", values: V2_MEMORY_CATEGORIES },
                    ids: { type: "array", items: "number", maxItems: 100 },
                    limit: "number",
                    reason: "string",
                });
                // Sidekick consumes untrusted `/ctx-aug` prompt text and is retrieval-only;
                // fail closed even if a future permission list accidentally exposes this tool.
                if (toolContext.agent === SIDEKICK_AGENT) {
                    return "Error: ctx_memory is not available to the sidekick agent.";
                }
                if (
                    args.action === undefined ||
                    (toolContext.agent !== DREAMER_AGENT && !allowedActions.includes(args.action))
                ) {
                    return `Error: Action '${args.action}' is not allowed in this context.`;
                }

                // Resolve the session's actual project from `toolContext.directory`
                // each call. OpenCode's top-level `ctx.directory` (the launch dir)
                // can differ from the session's working directory when the user
                // runs `opencode -s <id>` from outside the project.
                const projectPath = deps.resolveProjectPath(toolContext.directory);
                if (!projectPath) {
                    return "Error: Could not resolve project identity for memory action.";
                }
                const toolCallId = toolCallIdFromContext(toolContext);
                const claimsSchema = hasMemoryClaimsCompatSchema(deps.db);
                const claimOperationIdentity = (
                    suffix: string,
                    request: unknown,
                ): MemoryClaimOperationIdentity | undefined =>
                    toolCallId
                        ? {
                              producer: "ctx-memory-opencode",
                              // claim_operations is UNIQUE(producer, operation_key)
                              // across the whole DB while tool-call ids are only
                              // unique within a session; the session prefix keeps
                              // two sessions from colliding on the same call id.
                              operationKey: `${toolContext.sessionID}:${toolCallId}:${suffix}`,
                              requestDigest: computeClaimRequestDigest(request),
                          }
                        : undefined;
                await deps.ensureProjectRegistered?.(toolContext.directory, deps.db);
                if (args.action !== "list") {
                    const marker = getAuthorityManagedMarker(deps.db, projectPath);
                    let authorityState: "TS" | "PREPARING" | "MODULE" | "DRAINING" | null = null;
                    try {
                        authorityState =
                            (await deps.rustToolBackends?.authorityState?.({
                                projectPath,
                                projectRoot: toolContext.directory,
                                domain: "memories",
                            })) ?? null;
                    } catch (error) {
                        if (marker) {
                            return `Error: Rust memory authority is unavailable. ${error instanceof Error ? error.message : String(error)}`;
                        }
                    }
                    if (authorityState === "MODULE") {
                        const memoryBackend = deps.rustToolBackends?.memory;
                        if (!memoryBackend) {
                            return "Error: Rust memory authority is active, but this module transport does not support ctx_memory.";
                        }
                        // The native store carries no claim-policy fields; the
                        // TypeScript claims database stays the policy
                        // authority. Gate id-based targets here so a row the
                        // policy hides after mirroring cannot be read or
                        // mutated through the module lane. Agent-visible ids
                        // under MODULE authority are native module_row_id
                        // values, so translate them through the mirror before
                        // keying the claims database.
                        // Sub-verified rows stay readable through explicit get
                        // but must keep their sanitized trust labels: the
                        // native response text carries none, so the labels
                        // collected here are attached to the get output below,
                        // matching the TypeScript path's TRUST framing.
                        const moduleGetTrustLabels = new Map<number, string>();
                        if (args.ids && args.ids.length > 0 && hasClaimEffectivePolicy(deps.db)) {
                            const contextIdByModuleId = translateModuleMemoryIds(
                                deps.db,
                                projectPath,
                                args.ids,
                            );
                            const policyRows = readMemoryPolicyRows(deps.db, [
                                ...contextIdByModuleId.values(),
                            ]);
                            const denied = args.ids.find((id) => {
                                const contextId = contextIdByModuleId.get(id);
                                return (
                                    contextId !== undefined &&
                                    !decideMemoryPolicy(
                                        policyRows.get(contextId),
                                        "explicit_search",
                                    ).eligible
                                );
                            });
                            if (denied !== undefined) {
                                return args.action === "merge"
                                    ? "Error: One or more source memories were not found."
                                    : `Error: Memory with ID ${denied} was not found.`;
                            }
                            if (args.action === "get") {
                                for (const id of args.ids) {
                                    const contextId = contextIdByModuleId.get(id);
                                    if (contextId === undefined) continue;
                                    const decision = decideMemoryPolicy(
                                        policyRows.get(contextId),
                                        "explicit_search",
                                    );
                                    if (decision.label) {
                                        moduleGetTrustLabels.set(id, decision.label);
                                    }
                                }
                            }
                        }
                        // A write carries no ids, but the native store dedups
                        // by normalized hash and returns the existing row's id
                        // (bumping its seen count). The TypeScript claims
                        // database stays the policy authority, so content that
                        // duplicates a policy-hidden row must get the same
                        // uniform refusal the TS-authority write path returns
                        // instead of confirming the hidden row's existence.
                        if (
                            args.action === "write" &&
                            args.content &&
                            hasClaimEffectivePolicy(deps.db)
                        ) {
                            const category = getValidatedCategory(args.category?.trim() ?? "");
                            const duplicate = category
                                ? getMemoryByHash(
                                      deps.db,
                                      projectPath,
                                      category,
                                      computeNormalizedHash(args.content.trim()),
                                  )
                                : null;
                            if (duplicate) {
                                const policyRows = readMemoryPolicyRows(deps.db, [duplicate.id]);
                                const decision = decideMemoryPolicy(
                                    policyRows.get(duplicate.id),
                                    "explicit_search",
                                );
                                if (!decision.eligible) {
                                    return `Error: Memory could not be saved in ${category}.`;
                                }
                            }
                        }
                        try {
                            const text = moduleMemoryText(
                                await memoryBackend({
                                    ...(toolCallId ? { commandId: toolCallId } : {}),
                                    sessionId: toolContext.sessionID,
                                    projectRoot: toolContext.directory,
                                    projectPath,
                                    memoryProject: projectPath,
                                    action: args.action,
                                    content: args.content,
                                    category: args.category,
                                    ids: args.ids,
                                    reason: args.reason,
                                }),
                                args,
                            );
                            if (
                                text !== null &&
                                !text.startsWith("Error:") &&
                                moduleGetTrustLabels.size > 0
                            ) {
                                const labelLines = [...moduleGetTrustLabels.entries()].map(
                                    ([id, label]) => `- ID ${id}: ${label}`,
                                );
                                return `${text}\n\nTrust labels (sub-verified results):\n${labelLines.join("\n")}`;
                            }
                            return (
                                text ??
                                "Error: Rust module returned an invalid ctx_memory response."
                            );
                        } catch (error) {
                            if (isRustAuthorityDrainingError(error)) {
                                return memoryAuthorityRefusal(args);
                            }
                            return `Error: Rust module ctx_memory failed. ${error instanceof Error ? error.message : String(error)}`;
                        }
                    }
                    if (marker || authorityState === "PREPARING" || authorityState === "DRAINING") {
                        return memoryAuthorityRefusal(args);
                    }
                }
                const workspaceIdentitySet = resolveWorkspaceIdentitySet(deps.db, projectPath);
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
                          ) ?? projectIdentityForStoredPath(rawProjectPath))
                        : projectIdentityForStoredPath(rawProjectPath);
                // The workspace's share-category policy matches the render path.
                // null means there is no workspace filter; a workspaced caller gets
                // an explicit list where [] shares no foreign categories.
                const toolShareCategories =
                    workspaceIdentitySet.identities.length > 1
                        ? resolveWorkspaceShareCategories(deps.db, projectPath)
                        : null;
                // Visibility is the READ contract: own memories are visible in every
                // category, while foreign workspace memories are visible only in
                // categories the workspace explicitly shares. Mutations by primary
                // agents use memoryOwnedByTool below so shared visibility never
                // grants write access to another project.
                const memoryVisibleToTool = (memory: Memory): boolean => {
                    if (workspaceIdentitySet.identities.length <= 1) {
                        return memoryBelongsToProject(memory, projectPath);
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
                    const isOwn = targetIdentityForStoredPath(memory.projectPath) === projectPath;
                    if (isOwn) return true;
                    return (
                        (memory.status === "active" || memory.status === "permanent") &&
                        (memory.expiresAt === null || memory.expiresAt > Date.now()) &&
                        memory.shareable === 1 &&
                        ["project", "ecosystem", "universe"].includes(memory.scope) &&
                        (toolShareCategories?.includes(memory.category) ?? false)
                    );
                };
                const memoryOwnedByTool = (memory: Memory): boolean =>
                    workspaceIdentitySet.identities.length > 1
                        ? targetIdentityForStoredPath(memory.projectPath) === projectPath
                        : memoryBelongsToProject(memory, projectPath);
                // Hard-hidden and rejected rows return uniform absence on
                // every agent surface — including as MUTATION targets:
                // updating a policy-hidden memory would mint a fresh current
                // revision without the old revision's disposition and
                // resurface the content. One decision covers every id-based
                // branch (update, merge, archive) for every agent, so the
                // dreamer cannot feed hidden content back into its prompts
                // either.
                const memoryPolicyDeniesToolTarget = (memoryIds: readonly number[]): boolean => {
                    const rows = readMemoryPolicyRows(deps.db, memoryIds);
                    return memoryIds.some(
                        (id) => !decideMemoryPolicy(rows.get(id), "explicit_search").eligible,
                    );
                };
                const embeddingSnapshot = getProjectEmbeddingSnapshot(projectPath);
                if (
                    embeddingSnapshot
                        ? !embeddingSnapshot.features.memoryEnabled
                        : deps.memoryEnabled === false
                ) {
                    return getDisabledMessage();
                }

                if (args.action === "write") {
                    const content = args.content?.trim();
                    if (!content) {
                        return "Error: 'content' is required when action is 'write'.";
                    }

                    const rawCategory = args.category?.trim();
                    if (!rawCategory) {
                        return "Error: 'category' is required when action is 'write'.";
                    }

                    const category = getValidatedCategory(rawCategory);
                    if (!category) {
                        return `Error: Unknown memory category '${rawCategory}'.`;
                    }

                    const normalizedHash = computeNormalizedHash(content);
                    const writeRequest = {
                        projectPath,
                        category,
                        normalizedHash,
                        content,
                    };
                    const writeIdentity = claimOperationIdentity("write", writeRequest);
                    if (writeIdentity && claimsSchema) {
                        const envelope = toClaimOperationEnvelope(writeIdentity);
                        const replay = readMemoryClaimOperationResult<{
                            memoryId: number;
                            duplicate?: boolean;
                            denied?: boolean;
                        }>(deps.db, envelope);
                        if (replay) {
                            if (replay.result.denied) {
                                return `Error: Memory could not be saved in ${category}.`;
                            }
                            // The outcome was stored while the memory was
                            // visible; a quarantine/rejection since then must
                            // not leak the id through a committed-but-unacked
                            // retry. Same uniform refusal as a fresh denial.
                            if (memoryPolicyDeniesToolTarget([replay.result.memoryId])) {
                                return `Error: Memory could not be saved in ${category}.`;
                            }
                            return replay.result.duplicate
                                ? `Memory already exists [ID: ${replay.result.memoryId}] in ${category} (seen count incremented).`
                                : `Saved memory [ID: ${replay.result.memoryId}] in ${category}.`;
                        }
                        // The duplicate short-circuit runs inside the envelope so a
                        // committed-but-unacked write replays its stored outcome
                        // instead of re-bumping seen_count; the insert runs under
                        // its own storage-generated key.
                        const outcome = deps.db
                            .transaction(() =>
                                withMemoryClaimGenerationContextInCurrentTransaction(deps.db, () =>
                                    runMemoryClaimOperationInCurrentTransaction<{
                                        memoryId: number;
                                        duplicate: boolean;
                                        denied?: boolean;
                                    }>(deps.db, envelope, () => {
                                        const existing = getMemoryByHash(
                                            deps.db,
                                            projectPath,
                                            category,
                                            normalizedHash,
                                        );
                                        if (existing) {
                                            // A policy-hidden duplicate returns
                                            // uniform refusal: the UNIQUE row
                                            // cannot be re-inserted, and both
                                            // its id and its seen count must
                                            // stay undisclosed and untouched.
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
                                            projectPath: projectPath,
                                            category,
                                            content,
                                            sourceSessionId: toolContext.sessionID,
                                            sourceType:
                                                toolContext.agent === DREAMER_AGENT
                                                    ? "dreamer"
                                                    : getSourceType(deps),
                                        });
                                        if (!inserted.inserted) {
                                            // Raced duplicate recovered from the unique
                                            // constraint: same policy-before-mutation
                                            // contract as the pre-check branch above —
                                            // a hidden row's id and seen count stay
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
                            return `Error: Memory could not be saved in ${category}.`;
                        }
                        if (outcome.result.duplicate) {
                            if (!outcome.replayed) {
                                requestRustMemorySync(deps, toolContext.sessionID);
                            }
                            return `Memory already exists [ID: ${outcome.result.memoryId}] in ${category} (seen count incremented).`;
                        }
                        if (!outcome.replayed) {
                            queueMemoryEmbedding({
                                deps,
                                sessionId: toolContext.sessionID,
                                projectPath,
                                memoryId: outcome.result.memoryId,
                                content,
                            });
                            requestRustMemorySync(deps, toolContext.sessionID);
                        }
                        return `Saved memory [ID: ${outcome.result.memoryId}] in ${category}.`;
                    }

                    const existingMemory = getMemoryByHash(
                        deps.db,
                        projectPath,
                        category,
                        normalizedHash,
                    );
                    if (existingMemory) {
                        if (memoryPolicyDeniesToolTarget([existingMemory.id])) {
                            return `Error: Memory could not be saved in ${category}.`;
                        }
                        updateMemorySeenCount(deps.db, existingMemory.id);
                        requestRustMemorySync(deps, toolContext.sessionID);
                        return `Memory already exists [ID: ${existingMemory.id}] in ${category} (seen count incremented).`;
                    }

                    const insertResult = insertMemoryIdempotent(
                        deps.db,
                        {
                            projectPath: projectPath,
                            category,
                            content,
                            sourceSessionId: toolContext.sessionID,
                            sourceType:
                                toolContext.agent === DREAMER_AGENT
                                    ? "dreamer"
                                    : getSourceType(deps),
                        },
                        writeIdentity,
                    );
                    if (!insertResult.inserted) {
                        // The recovery is non-mutating, so the policy decision
                        // runs before the raced row is touched: a hidden
                        // duplicate gets the uniform refusal with its seen
                        // count intact.
                        if (memoryPolicyDeniesToolTarget([insertResult.memory.id])) {
                            return `Error: Memory could not be saved in ${category}.`;
                        }
                        updateMemorySeenCount(deps.db, insertResult.memory.id);
                        requestRustMemorySync(deps, toolContext.sessionID);
                        return `Memory already exists [ID: ${insertResult.memory.id}] in ${category} (seen count incremented).`;
                    }

                    queueMemoryEmbedding({
                        deps,
                        sessionId: toolContext.sessionID,
                        projectPath,
                        memoryId: insertResult.memory.id,
                        content,
                    });
                    requestRustMemorySync(deps, toolContext.sessionID);

                    return `Saved memory [ID: ${insertResult.memory.id}] in ${category}.`;
                }

                if (args.action === "list") {
                    const limit = normalizeLimit(args.limit);
                    const category = normalizeCategory(args.category);
                    // The explicit-surface decision applies before the limit:
                    // hard-hidden rows get uniform absence; sub-verified rows
                    // keep sanitized trust labels.
                    const policyFiltered = filterMemoriesByPolicy(
                        deps.db,
                        filterByCategory(getMemoriesByProject(deps.db, projectPath), category),
                        "explicit_search",
                    );
                    const memories = policyFiltered.memories.slice(0, limit);
                    return formatMemoryList(memories, policyFiltered.labels);
                }

                if (args.action === "get") {
                    const getIds = args.ids;
                    if (!getIds || getIds.length === 0 || !getIds.every(Number.isInteger)) {
                        return "Error: 'ids' must contain at least one integer memory ID when action is 'get'.";
                    }
                    if (getIds.length > GET_MAX_IDS) {
                        return `Error: 'ids' must contain at most ${GET_MAX_IDS} memory IDs when action is 'get' (got ${getIds.length}).`;
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
                    return formatGetOutput({
                        requestedIds: uniqueIds,
                        memoriesById,
                        policyLabels: policyFiltered.labels,
                    });
                }

                if (args.action === "update") {
                    const updateIds = args.ids;
                    if (updateIds?.length !== 1 || !updateIds.every(Number.isInteger)) {
                        return "Error: 'ids' must contain exactly one integer memory ID when action is 'update'.";
                    }
                    const updateId = updateIds[0];

                    const content = args.content?.trim();
                    if (!content) {
                        return "Error: 'content' is required when action is 'update'.";
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
                    if (updateIdentity && claimsSchema) {
                        const replay = readMemoryClaimOperationResult<{
                            memoryId: number;
                            category: string;
                        }>(deps.db, toClaimOperationEnvelope(updateIdentity));
                        if (replay) {
                            // The stored outcome predates any later
                            // quarantine/rejection: refuse instead of
                            // re-disclosing a now-hidden id on retry.
                            if (memoryPolicyDeniesToolTarget([replay.result.memoryId])) {
                                return `Error: Memory with ID ${updateId} was not found.`;
                            }
                            return `Updated memory [ID: ${replay.result.memoryId}] in ${replay.result.category}.`;
                        }
                    }

                    const rawProjectPath = projectPathForMemoryId(deps.db, updateId);
                    const memory = getMemoryById(deps.db, updateId);
                    const updateAllowed = memory
                        ? toolContext.agent === DREAMER_AGENT
                            ? memoryVisibleToTool(memory)
                            : memoryOwnedByTool(memory)
                        : false;
                    if (
                        !memory ||
                        !rawProjectPath ||
                        !updateAllowed ||
                        memoryPolicyDeniesToolTarget([updateId])
                    ) {
                        return `Error: Memory with ID ${updateId} was not found.`;
                    }
                    if (toolContext.agent !== DREAMER_AGENT && !isPrimaryMutableMemory(memory)) {
                        return inactiveMemoryError(updateId, "updating");
                    }

                    const duplicate = getMemoryByHash(
                        deps.db,
                        targetIdentityForStoredPath(rawProjectPath),
                        memory.category,
                        normalizedHash,
                    );
                    if (duplicate && duplicate.id !== memory.id) {
                        // Never disclose a policy-hidden duplicate's id; the
                        // UNIQUE constraint forces a refusal either way.
                        return memoryPolicyDeniesToolTarget([duplicate.id])
                            ? "Error: Memory content already exists; choose different content."
                            : `Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`;
                    }

                    const projectIdentity = targetIdentityForStoredPath(rawProjectPath);
                    let replayed = false;
                    let deniedInTransaction = false;
                    deps.db
                        .transaction(() =>
                            withMemoryClaimGenerationContextInCurrentTransaction(deps.db, () => {
                                // The visibility snapshot above ran outside
                                // this transaction: another process can
                                // quarantine or reject the target in the gap,
                                // and appending a successor revision would
                                // strip the hidden revision's disposition.
                                // Re-evaluate while holding the write lock.
                                if (memoryPolicyDeniesToolTarget([memory.id])) {
                                    deniedInTransaction = true;
                                    return;
                                }
                                if (updateIdentity && claimsSchema) {
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
                                                projectPath: projectIdentity,
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
                                        projectPath: projectIdentity,
                                        mutationType: "update",
                                        targetMemoryId: memory.id,
                                        category: memory.category,
                                        newContent: content,
                                    });
                                }
                            }),
                        )
                        .immediate();
                    if (deniedInTransaction) {
                        return `Error: Memory with ID ${updateId} was not found.`;
                    }
                    if (replayed) {
                        return `Updated memory [ID: ${memory.id}] in ${memory.category}.`;
                    }
                    queueMemoryEmbedding({
                        deps,
                        sessionId: toolContext.sessionID,
                        projectPath: projectIdentity,
                        memoryId: memory.id,
                        content,
                    });
                    requestRustMemorySync(deps, toolContext.sessionID);

                    return `Updated memory [ID: ${memory.id}] in ${memory.category}.`;
                }

                if (args.action === "merge") {
                    const ids = args.ids;
                    if (!ids || ids.length < 2 || !ids.every(Number.isInteger)) {
                        return "Error: 'ids' must include at least two integer memory IDs when action is 'merge'.";
                    }
                    if (new Set(ids).size !== ids.length) {
                        return "Error: 'ids' must include at least two distinct memory IDs when action is 'merge'.";
                    }

                    const content = args.content?.trim();
                    if (!content) {
                        return "Error: 'content' is required when action is 'merge'.";
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
                        requestedCategory: args.category ?? null,
                        projectPath,
                    });
                    // Replay before the source-existence and category checks: a
                    // source deleted between attempts must not turn a
                    // committed-but-unacked merge retry into a not-found or
                    // category error. The stored result carries the category so
                    // the message never depends on the live sources.
                    if (mergeIdentity && claimsSchema) {
                        const replay = readMemoryClaimOperationResult<{
                            memoryId: number;
                            category: string;
                        }>(deps.db, toClaimOperationEnvelope(mergeIdentity));
                        if (replay) {
                            // The stored outcome predates any later
                            // quarantine/rejection: refuse instead of
                            // re-disclosing a now-hidden id on retry.
                            if (memoryPolicyDeniesToolTarget([replay.result.memoryId])) {
                                return "Error: One or more source memories were not found.";
                            }
                            const supersededIds = ids.filter((id) => id !== replay.result.memoryId);
                            return `Merged memories [${ids.join(", ")}] into canonical memory [ID: ${replay.result.memoryId}] in ${replay.result.category}; superseded [${supersededIds.join(", ")}].`;
                        }
                    }
                    const sourceMemories = ids
                        .map((id) => getMemoryById(deps.db, id))
                        .filter((memory): memory is Memory => Boolean(memory));
                    const category =
                        getValidatedCategory(args.category) ?? sourceMemories[0]?.category ?? null;
                    if (!category) {
                        // An unresolvable category usually means the sources are
                        // gone (it falls back to sourceMemories[0]); report the
                        // real problem instead of a misleading category error.
                        return sourceMemories.length !== ids.length
                            ? "Error: One or more source memories were not found."
                            : "Error: A valid category is required when action is 'merge'.";
                    }
                    if (sourceMemories.length !== ids.length) {
                        return "Error: One or more source memories were not found.";
                    }
                    if (memoryPolicyDeniesToolTarget(ids)) {
                        return "Error: One or more source memories were not found.";
                    }
                    // Cross-identity consolidation is a DREAMER-ONLY capability: the
                    // loop below supersedes each source under ITS OWN project identity
                    // and queues a per-project supersede-delta row, so every affected
                    // project's m[1] reconciles. But `merge` is now in the primary
                    // action set too, and a primary agent must not be able to reach
                    // into ANOTHER project's memories. So mirror update/archive: a
                    // non-dreamer caller may only merge memories that all belong to
                    // its own resolved project. The dreamer keeps the cross-identity
                    // path (see the "merging across identities" test).
                    if (toolContext.agent !== DREAMER_AGENT) {
                        const foreign = sourceMemories.find((memory) => !memoryOwnedByTool(memory));
                        if (foreign) {
                            return `Error: Memory with ID ${foreign.id} was not found.`;
                        }
                        const inactive = sourceMemories.find(
                            (memory) => !isPrimaryMutableMemory(memory),
                        );
                        if (inactive) {
                            return inactiveMemoryError(inactive.id, "merging");
                        }
                    } else if (workspaceIdentitySet.identities.length > 1) {
                        // The dreamer keeps its cross-PROJECT merge power (#5971) OUTSIDE
                        // a workspace (the branch above leaves non-workspace dreamer
                        // merges unrestricted). But INSIDE a workspace, per-category
                        // sharing is the user's explicit privacy boundary that even the
                        // system's own consolidation worker honors: a FOREIGN member's
                        // memory in a non-shared category (or a non-member project's
                        // memory) is off-limits. memoryVisibleToTool already encodes
                        // exactly that for the workspace case (own → true,
                        // foreign-shared-category → true, else → false).
                        const blocked = sourceMemories.find(
                            (memory) => !memoryVisibleToTool(memory),
                        );
                        if (blocked) {
                            return `Error: Memory with ID ${blocked.id} is in a category not shared with this workspace member and cannot be merged.`;
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
                        return `Error: Cannot merge memories from different categories (${[...sourceCategories].join(", ")}). If they are genuine duplicates, one is miscategorized — archive the redundant one instead of merging across categories.`;
                    }

                    const mergedFrom = JSON.stringify(
                        Array.from(
                            new Set(
                                sourceMemories.flatMap((memory) => {
                                    let parsed: unknown[];
                                    try {
                                        parsed = memory.mergedFrom
                                            ? JSON.parse(memory.mergedFrom)
                                            : [];
                                    } catch {
                                        parsed = [];
                                    }
                                    return [
                                        memory.id,
                                        ...(Array.isArray(parsed)
                                            ? parsed.filter(
                                                  (value): value is number =>
                                                      typeof value === "number",
                                              )
                                            : []),
                                    ];
                                }),
                            ),
                        ).sort((left, right) => left - right),
                    );
                    const mergedSeenCount = sourceMemories.reduce(
                        (sum, memory) => sum + memory.seenCount,
                        0,
                    );
                    const mergedRetrievalCount = sourceMemories.reduce(
                        (sum, memory) => sum + memory.retrievalCount,
                        0,
                    );
                    const mergedStatus = sourceMemories.some(
                        (memory) => memory.status === "permanent",
                    )
                        ? "permanent"
                        : "active";

                    let mergeConflict: string | null = null;
                    let mergeReplayed = false;
                    const canonicalMemoryId = deps.db
                        .transaction(() =>
                            withMemoryClaimGenerationContextInCurrentTransaction(deps.db, () => {
                                // The source-visibility snapshot ran outside
                                // this transaction: re-evaluate every source
                                // while holding the write lock so a target
                                // hidden in the gap is neither superseded nor
                                // resurfaced through the merged successor.
                                if (memoryPolicyDeniesToolTarget(ids)) {
                                    mergeConflict =
                                        "Error: One or more source memories were not found.";
                                    return null;
                                }
                                if (mergeIdentity && claimsSchema) {
                                    const replay = readMemoryClaimOperationResult<{
                                        memoryId: number;
                                        category: string;
                                    }>(deps.db, toClaimOperationEnvelope(mergeIdentity));
                                    if (replay) {
                                        mergeReplayed = true;
                                        return replay.result.memoryId;
                                    }
                                }
                                const lockedDuplicate = getMemoryByHash(
                                    deps.db,
                                    projectPath,
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
                                    return null;
                                }

                                const nextCanonical =
                                    canonicalExisting?.id != null
                                        ? canonicalExisting
                                        : insertMemoryIdempotent(deps.db, {
                                              projectPath: projectPath,
                                              category,
                                              content,
                                              sourceSessionId: toolContext.sessionID,
                                              sourceType:
                                                  toolContext.agent === DREAMER_AGENT
                                                      ? "dreamer"
                                                      : getSourceType(deps),
                                          }).memory;
                                const canonicalContentChanged =
                                    nextCanonical.content !== content ||
                                    nextCanonical.normalizedHash !== normalizedHash;

                                if (canonicalContentChanged) {
                                    updateMemoryContentInCurrentTransaction(
                                        deps.db,
                                        nextCanonical,
                                        content,
                                        normalizedHash,
                                    );
                                }

                                mergeMemoryStats(
                                    deps.db,
                                    nextCanonical.id,
                                    mergedSeenCount,
                                    mergedRetrievalCount,
                                    mergedFrom,
                                    mergedStatus,
                                );

                                for (const memory of sourceMemories) {
                                    if (memory.id === nextCanonical.id) {
                                        continue;
                                    }
                                    supersededMemory(deps.db, memory.id, nextCanonical.id);
                                    queueMemoryMutation(deps.db, {
                                        projectPath: projectIdentityForStoredPath(
                                            memory.projectPath,
                                        ),
                                        mutationType: "superseded",
                                        targetMemoryId: memory.id,
                                        supersededById: nextCanonical.id,
                                    });
                                }

                                if (canonicalExisting && canonicalContentChanged) {
                                    queueMemoryMutation(deps.db, {
                                        projectPath: projectIdentityForStoredPath(
                                            nextCanonical.projectPath,
                                        ),
                                        mutationType: "update",
                                        targetMemoryId: nextCanonical.id,
                                        category,
                                        newContent: content,
                                    });
                                }

                                // The tool owns the merge envelope so the stored
                                // result carries the category the replay message
                                // needs; the storage-layer writes above run under
                                // their own generated keys.
                                if (mergeIdentity && claimsSchema) {
                                    runMemoryClaimOperationInCurrentTransaction(
                                        deps.db,
                                        toClaimOperationEnvelope(mergeIdentity),
                                        () => ({
                                            result: { memoryId: nextCanonical.id, category },
                                            effects: [],
                                        }),
                                    );
                                }

                                return nextCanonical.id;
                            }),
                        )
                        .immediate();
                    if (mergeConflict || canonicalMemoryId === null) {
                        return mergeConflict ?? "Error: Failed to merge memories.";
                    }

                    if (!mergeReplayed) {
                        queueMemoryEmbedding({
                            deps,
                            sessionId: toolContext.sessionID,
                            projectPath,
                            memoryId: canonicalMemoryId,
                            content,
                        });
                        requestRustMemorySync(deps, toolContext.sessionID);
                    }

                    const supersededIds = sourceMemories
                        .map((memory) => memory.id)
                        .filter((id) => id !== canonicalMemoryId);
                    return `Merged memories [${ids.join(", ")}] into canonical memory [ID: ${canonicalMemoryId}] in ${category}; superseded [${supersededIds.join(", ")}].`;
                }

                if (args.action === "archive") {
                    const rawArchiveIds = args.ids;
                    if (
                        !rawArchiveIds ||
                        rawArchiveIds.length === 0 ||
                        !rawArchiveIds.every(Number.isInteger)
                    ) {
                        return "Error: 'ids' must contain at least one integer memory ID when action is 'archive'.";
                    }
                    // De-dupe (first-seen order) so `ids:[42,42]` archives once and
                    // queues one mutation-log row instead of two.
                    const archiveIds = [...new Set(rawArchiveIds)];
                    const archiveIdentity = (
                        memoryId: number,
                    ): MemoryClaimOperationIdentity | undefined =>
                        claimOperationIdentity(
                            `archive:${memoryId}`,
                            args.reason?.trim()
                                ? { id: memoryId, reason: args.reason.trim() }
                                : { id: memoryId, status: "archived" },
                        );
                    const archiveReplay = archiveIds.every((memoryId) => {
                        const identity = archiveIdentity(memoryId);
                        return (
                            identity !== undefined &&
                            claimsSchema &&
                            readMemoryClaimOperationResult(
                                deps.db,
                                toClaimOperationEnvelope(identity),
                            ) !== null
                        );
                    });
                    if (archiveReplay) {
                        const idList = archiveIds.join(", ");
                        const plural = archiveIds.length > 1 ? "memories" : "memory";
                        return args.reason?.trim()
                            ? `Archived ${plural} [ID: ${idList}] (${args.reason.trim()}).`
                            : `Archived ${plural} [ID: ${idList}].`;
                    }

                    // Validate the whole batch BEFORE mutating anything so a typo'd
                    // id can't half-archive a batch (all-or-nothing, matching the
                    // single-transaction write below).
                    const targets: Array<{ memoryId: number; projectIdentity: string }> = [];
                    for (const memoryId of archiveIds) {
                        const rawProjectPath = projectPathForMemoryId(deps.db, memoryId);
                        const memory = getMemoryById(deps.db, memoryId);
                        const archiveAllowed = memory
                            ? toolContext.agent === DREAMER_AGENT
                                ? memoryVisibleToTool(memory)
                                : memoryOwnedByTool(memory)
                            : false;
                        if (
                            !memory ||
                            !rawProjectPath ||
                            !archiveAllowed ||
                            memoryPolicyDeniesToolTarget([memoryId])
                        ) {
                            return `Error: Memory with ID ${memoryId} was not found.`;
                        }
                        if (
                            toolContext.agent !== DREAMER_AGENT &&
                            !isPrimaryMutableMemory(memory)
                        ) {
                            // Mirror update/merge: once the primary agent archived or
                            // superseded this memory, re-archiving it should return the
                            // same friendly inactive-memory error instead of mutating it.
                            return inactiveMemoryError(memoryId, "archiving");
                        }
                        targets.push({
                            memoryId,
                            projectIdentity: targetIdentityForStoredPath(rawProjectPath),
                        });
                    }

                    let archiveDeniedInTransaction = false;
                    deps.db
                        .transaction(() =>
                            withMemoryClaimGenerationContextInCurrentTransaction(deps.db, () => {
                                // The per-target visibility loop above ran
                                // outside this transaction: re-evaluate the
                                // whole batch while holding the write lock so
                                // a target hidden in the gap is not mutated
                                // (all-or-nothing, matching the batch below).
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
                                        args.reason,
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
                            }),
                        )
                        .immediate();
                    if (archiveDeniedInTransaction) {
                        return "Error: One or more memories were not found.";
                    }
                    requestRustMemorySync(deps, toolContext.sessionID);
                    const idList = targets.map((t) => t.memoryId).join(", ");
                    const plural = targets.length > 1 ? "memories" : "memory";
                    return args.reason?.trim()
                        ? `Archived ${plural} [ID: ${idList}] (${args.reason.trim()}).`
                        : `Archived ${plural} [ID: ${idList}].`;
                }

                return "Error: Unknown action.";
            } catch (error) {
                // A digest mismatch on a re-presented tool-call id is caller
                // error; report it as a tool result instead of throwing out
                // of execute().
                if (error instanceof ClaimOperationKeyReuseError) {
                    return "Error: this tool call id was already committed with different arguments. Retry as a new call.";
                }
                throw error;
            }
        },
    });
}

export function createCtxMemoryTools(deps: CtxMemoryToolDeps): Record<string, ToolDefinition> {
    return {
        [CTX_MEMORY_TOOL_NAME]: createCtxMemoryTool(deps),
    };
}
