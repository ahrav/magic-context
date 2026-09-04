/**
 * The harness-neutral body of `ctx_memory`: reads and writes project memory
 * through the kernel client and renders every outcome as tool text. The
 * OpenCode and Pi tool wrappers parse their own argument shapes and call
 * `executeCtxMemory`, so both harnesses produce byte-identical results.
 */

import {
    type AntiMemoryPayload,
    parseAntiMemoryContent,
    renderAntiMemoryContent,
} from "../../features/magic-context/memory/anti-memory-content";
import { ClaimOperationInputError } from "../../features/magic-context/memory/claim-operation-contract";
import { ANTI_MEMORY_CATEGORY } from "../../features/magic-context/memory/constants";
import {
    type CommitResult,
    type DecisionSpecInput,
    isAvailable,
    isMemoryDecisionRow,
    type KernelClient,
    MEMORY_DOMAIN_ID,
    type MemoryState,
    type MutationArgs,
    OPERATION_KEY_SEPARATOR,
    type ReadRow,
    renderToolStateText,
    type SourceKind,
    sha256Hex,
} from "../../shared/kernel-client";
import { DEFAULT_SEARCH_LIMIT, GET_MAX_CLAIMS } from "./constants";
import type { CtxMemoryAction, CtxMemoryArgs } from "./types";
import { assertCtxMemoryWriteShape } from "./write-shape";

/** Every memory the tool writes lives in this kernel domain. */
export const CTX_MEMORY_DOMAIN_ID = MEMORY_DOMAIN_ID;
/** The lineage every tool-written decision names; revisions advance `source_revision`. */
export const CTX_MEMORY_SOURCE_ID = "ctx_memory";
export const CTX_MEMORY_ACTOR = "agent:opencode";
export const CTX_MEMORY_DREAMER_ACTOR = "agent:opencode:dreamer";

function normalizeLimit(limit: number | undefined): number {
    if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
    return Math.max(1, Math.min(100, Math.floor(limit)));
}

function uniqueIds(ids: readonly string[] | undefined): string[] {
    return [...new Set((ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0))];
}

function memoryView(row: ReadRow): Record<string, unknown> {
    const decision = row.decision;
    const category = decision?.decision_kind ?? row.object.object_kind;
    const content = decision?.payload.summary ?? "";
    let antiMemory: AntiMemoryPayload | undefined;
    if (category === ANTI_MEMORY_CATEGORY) {
        try {
            antiMemory = parseAntiMemoryContent(content);
        } catch {
            antiMemory = undefined;
        }
    }
    return {
        objectId: row.object.object_id,
        category,
        content,
        ...(antiMemory ? { antiMemory } : {}),
        ...(decision?.payload.rationale ? { rationale: decision.payload.rationale } : {}),
        labeled: row.labeled,
        sensitivity: row.object.sensitivity,
        knownAsOf: row.token.known_as_of,
    };
}

/** Tool text for a state other than `available`; a conflict names the object to re-read. */
export function renderCtxMemoryStateText(state: MemoryState, objectIds: readonly string[]): string {
    const text = renderToolStateText(state);
    if (state.kind === "conflict" && objectIds.length > 0) {
        return `Error: ${text} Re-read ${objectIds.join(", ")} with ctx_memory get, then retry.`;
    }
    return `Error: ${text}`;
}

/** The tool call a write derives its object ids from. */
export interface CtxMemoryWriteIdentity {
    sessionId: string;
    toolCallId: string;
}

/**
 * Object and decision ids derive from the tool call so a replayed call
 * produces byte-identical operations and the daemon reports `replayed`
 * instead of minting a second object.
 */
function derivedId(prefix: string, identity: CtxMemoryWriteIdentity, index: number): string {
    return `${prefix}_${sha256Hex(`${identity.sessionId}\u001f${identity.toolCallId}\u001f${prefix}\u001f${index}`).slice(0, 32)}`;
}

function contentOf(args: CtxMemoryArgs): string {
    if (args.antiMemory) return renderAntiMemoryContent(args.antiMemory);
    const content = args.content?.trim() ?? "";
    if (!content) throw new ClaimOperationInputError("content is required");
    return content;
}

function decisionSpec(
    args: CtxMemoryArgs,
    category: string,
    identity: CtxMemoryWriteIdentity,
    lineage: { sourceId: string; sourceRevision: number },
): DecisionSpecInput {
    return {
        decision_id: derivedId("dec", identity, 0),
        object_id: derivedId("mem", identity, 0),
        domain_id: CTX_MEMORY_DOMAIN_ID,
        decision_kind: category,
        payload: { summary: contentOf(args), rationale: args.reason?.trim() ?? "" },
        source_id: lineage.sourceId,
        source_revision: lineage.sourceRevision,
    };
}

/**
 * All predecessors must share source_id and source_kind because a successor
 * has one source lineage.
 */
function successorLineage(predecessors: readonly ReadRow[]): {
    sourceId: string;
    sourceKind: SourceKind;
} {
    const first = predecessors[0] as ReadRow;
    for (const row of predecessors) {
        if (
            row.object.source_id !== first.object.source_id ||
            row.object.source_kind !== first.object.source_kind
        ) {
            throw new ClaimOperationInputError(
                "merge targets have different lineages (source_id/source_kind); one survivor cannot supersede them all. Merge same-lineage memories only.",
            );
        }
    }
    return {
        sourceId: first.object.source_id,
        // The store holds only source kinds the daemon admitted.
        sourceKind: first.object.source_kind as SourceKind,
    };
}

/**
 * Every mutation target must be a memory this project can read: the daemon
 * resolves ids store-wide and checks only the tokens it is handed, so the
 * project-scoped read is the authorization boundary.
 */
function requireVisible(rows: readonly ReadRow[], targets: readonly string[]): ReadRow[] {
    const visible = rows.filter((row) => targets.includes(row.object.object_id));
    const seen = new Set(visible.map((row) => row.object.object_id));
    const missing = targets.filter((id) => !seen.has(id));
    if (missing.length > 0) {
        throw new ClaimOperationInputError(
            `memory not found or not visible from this project: ${missing.join(", ")}`,
        );
    }
    return visible;
}

function requireTarget(args: CtxMemoryArgs): string {
    const objectId = args.objectId?.trim();
    if (!objectId) {
        throw new ClaimOperationInputError(
            `'objectId' is required when action is '${String(args.action)}'`,
        );
    }
    return objectId;
}

/** `objectId` names the written object (the survivor for revise/merge) apart from the retired predecessors that `objects` also lists; `archive` writes none. commentlint: allow(JUDGE) */
function renderCommit(
    action: CtxMemoryAction,
    result: CommitResult,
    targets: string[],
    writtenObjectId?: string,
): string {
    if (!isAvailable(result)) return renderCtxMemoryStateText(result.state, targets);
    return JSON.stringify({
        action,
        outcome: result.receipt.replayed ? "already applied" : "applied",
        commitSeq: result.receipt.commit_seq,
        knownAsOf: result.known_as_of,
        ...(writtenObjectId === undefined ? {} : { objectId: writtenObjectId }),
        objects: result.tokens.map((token) => token.object_id),
    });
}

export interface ExecuteCtxMemoryArgs {
    client: KernelClient;
    args: CtxMemoryArgs;
    action: CtxMemoryAction;
    identity: CtxMemoryWriteIdentity;
    actor: string;
    /** The source kind `create` commits under; replacements inherit the predecessor's kind. */
    sourceKind?: SourceKind;
}

async function readMemoryRows(
    client: KernelClient,
): Promise<{ ok: true; rows: ReadRow[]; knownAsOf: number } | { ok: false; state: MemoryState }> {
    const read = await client.read({ surface: "explicit_search", gated: false });
    if (!isAvailable(read)) return { ok: false, state: read.state };
    return { ok: true, rows: read.rows.filter(isMemoryDecisionRow), knownAsOf: read.known_as_of };
}

/** The category a revision keeps unless the call names another; `rationale` follows the same rule. */
function revisionArgs(args: CtxMemoryArgs, predecessors: readonly ReadRow[]): CtxMemoryArgs {
    const first = predecessors[0];
    const inherited = {
        ...(args.category === undefined && first?.decision
            ? { category: first.decision.decision_kind }
            : {}),
        ...(args.content === undefined && args.antiMemory === undefined && first?.decision
            ? { content: first.decision.payload.summary }
            : {}),
        ...(args.reason === undefined && first?.decision?.payload.rationale
            ? { reason: first.decision.payload.rationale }
            : {}),
    };
    return { ...args, ...inherited };
}

function nextSourceRevision(predecessors: readonly ReadRow[]): number {
    return predecessors.reduce((max, row) => Math.max(max, row.object.source_revision), 0) + 1;
}

/** A `retire_decision` operation carries no payload, so the caller's reason rides in the commit intent's `cause` after the tool-call id; `deriveOperationKey` joins fields with `OPERATION_KEY_SEPARATOR`, and the reason drops that separator to keep operation keys unambiguous. commentlint: allow(JUDGE) */
function archiveCause(identity: CtxMemoryWriteIdentity, reason: string | undefined): string {
    const trimmed = reason?.trim().replaceAll(OPERATION_KEY_SEPARATOR, " ");
    return trimmed ? `${identity.toolCallId} reason: ${trimmed}` : identity.toolCallId;
}

export async function executeCtxMemory(input: ExecuteCtxMemoryArgs): Promise<string> {
    const { client, args, action, identity, actor, sourceKind } = input;
    const mutation: MutationArgs = { actor, cause: identity.toolCallId };

    if (action === "get" || action === "list") {
        const read = await readMemoryRows(client);
        if (!read.ok) return renderCtxMemoryStateText(read.state, []);
        if (action === "get") {
            const wanted = uniqueIds(args.objectIds);
            if (wanted.length === 0) {
                return "Error: 'objectIds' is required when action is 'get'.";
            }
            if (wanted.length > GET_MAX_CLAIMS) {
                throw new ClaimOperationInputError(
                    `get accepts at most ${GET_MAX_CLAIMS} objectIds; ${wanted.length} were given. Split the request.`,
                );
            }
            const found = read.rows.filter((row) => wanted.includes(row.object.object_id));
            const foundIds = new Set(found.map((row) => row.object.object_id));
            return JSON.stringify({
                action,
                knownAsOf: read.knownAsOf,
                memories: found.map(memoryView),
                missingObjectIds: wanted.filter((id) => !foundIds.has(id)),
            });
        }
        const category = args.category?.trim();
        const listed = read.rows
            .filter((row) => !category || row.decision?.decision_kind === category)
            .sort((left, right) => (left.object.object_id < right.object.object_id ? -1 : 1))
            .slice(0, normalizeLimit(args.limit));
        return JSON.stringify({
            action,
            knownAsOf: read.knownAsOf,
            memories: listed.map(memoryView),
        });
    }

    if (action === "create") {
        const category = args.category?.trim() ?? "";
        const spec = decisionSpec(args, category, identity, {
            sourceId: CTX_MEMORY_SOURCE_ID,
            sourceRevision: 1,
        });
        const createMutation = sourceKind === undefined ? mutation : { ...mutation, sourceKind };
        return renderCommit(action, await client.create(spec, createMutation), [], spec.object_id);
    }

    if (action === "archive") {
        const target = requireTarget(args);
        const read = await readMemoryRows(client);
        if (!read.ok) return renderCtxMemoryStateText(read.state, [target]);
        requireVisible(read.rows, [target]);
        return renderCommit(
            action,
            await client.archive(target, { actor, cause: archiveCause(identity, args.reason) }),
            [target],
        );
    }

    if (action === "revise") {
        const target = requireTarget(args);
        const read = await readMemoryRows(client);
        if (!read.ok) return renderCtxMemoryStateText(read.state, [target]);
        const predecessors = requireVisible(read.rows, [target]);
        const merged = revisionArgs(args, predecessors);
        assertCtxMemoryWriteShape({ ...merged, action: "revise" });
        const category = merged.category?.trim();
        if (!category) {
            throw new ClaimOperationInputError(`revise requires a category for ${target}`);
        }
        const lineage = successorLineage(predecessors);
        const spec = decisionSpec(merged, category, identity, {
            sourceId: lineage.sourceId,
            sourceRevision: nextSourceRevision(predecessors),
        });
        return renderCommit(
            action,
            await client.revise(target, spec, { ...mutation, sourceKind: lineage.sourceKind }),
            [target],
            spec.object_id,
        );
    }

    const targets = uniqueIds(args.objectIds);
    if (targets.length < 2) {
        throw new ClaimOperationInputError("merge requires at least two objectIds");
    }
    const read = await readMemoryRows(client);
    if (!read.ok) return renderCtxMemoryStateText(read.state, targets);
    const predecessors = requireVisible(read.rows, targets);
    const merged = revisionArgs(args, predecessors);
    assertCtxMemoryWriteShape({ ...merged, action: "revise" });
    const category = merged.category?.trim();
    if (!category) throw new ClaimOperationInputError("merge requires a category");
    const lineage = successorLineage(predecessors);
    const spec = decisionSpec(merged, category, identity, {
        sourceId: lineage.sourceId,
        sourceRevision: nextSourceRevision(predecessors),
    });
    return renderCommit(
        action,
        await client.merge(targets, spec, { ...mutation, sourceKind: lineage.sourceKind }),
        targets,
        spec.object_id,
    );
}
