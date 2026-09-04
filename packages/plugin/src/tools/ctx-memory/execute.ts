/**
 * The harness-neutral body of `ctx_memory`: reads and writes project memory
 * through the kernel client and renders every outcome as tool text. The
 * OpenCode and Pi tool wrappers parse their own argument shapes and call
 * `executeCtxMemory`, so both harnesses produce byte-identical results.
 */

import {
    ANTI_MEMORY_DEFAULT_TTL_MS,
    type AntiMemoryPayload,
    antiMemoryExpired,
    parseAntiMemoryContent,
    renderAntiMemoryContent,
} from "../../features/magic-context/memory/anti-memory-content";
import { ClaimOperationInputError } from "../../features/magic-context/memory/claim-operation-contract";
import { ANTI_MEMORY_CATEGORY } from "../../features/magic-context/memory/constants";
import {
    MAX_RENDER_FIELD_BYTES,
    truncateUtf8Bytes,
} from "../../features/magic-context/search-bounds";
import {
    type CommitResult,
    type DecisionSpecInput,
    deriveObjectId,
    isAvailable,
    isMemoryDecisionRow,
    type KernelClient,
    MEMORY_DOMAIN_ID,
    type MemoryState,
    type MutationArgs,
    OPERATION_KEY_SEPARATOR,
    type ReadRow,
    renderToolStateText,
    SENSITIVITIES,
    type Sensitivity,
    type SourceKind,
} from "../../shared/kernel-client";
import {
    CTX_MEMORY_RESPONSE_BUDGET_BYTES,
    DEFAULT_SEARCH_LIMIT,
    GET_MAX_CLAIMS,
    MERGE_MAX_TARGETS,
} from "./constants";
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
    // The wrappers fall back to unvalidated raw arguments when schema parsing fails, so the check rejects non-string entries before `.trim()` throws a TypeError. commentlint: allow(JUDGE)
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) {
        throw new ClaimOperationInputError("'objectIds' must be an array of strings");
    }
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

/** The marker a bounded field ends with, so an elided middle is visible in the tool text. */
const CTX_MEMORY_TRUNCATION_MARKER = "… [truncated]";

function boundedText(text: string): string {
    if (Buffer.byteLength(text, "utf8") <= MAX_RENDER_FIELD_BYTES) return text;
    return `${truncateUtf8Bytes(text, MAX_RENDER_FIELD_BYTES)}${CTX_MEMORY_TRUNCATION_MARKER}`;
}

/** Bounds every string the view serializes — content, rationale, and parsed anti-memory fields — to the shared per-field byte cap. */
function boundedMemoryView(row: ReadRow): Record<string, unknown> {
    const view = memoryView(row);
    const bounded: Record<string, unknown> = { ...view };
    if (typeof view.content === "string") bounded.content = boundedText(view.content);
    if (typeof view.rationale === "string") bounded.rationale = boundedText(view.rationale);
    if (view.antiMemory !== undefined) {
        const antiMemory: Record<string, unknown> = {
            ...(view.antiMemory as Record<string, unknown>),
        };
        for (const [key, value] of Object.entries(antiMemory)) {
            if (typeof value === "string") antiMemory[key] = boundedText(value);
        }
        bounded.antiMemory = antiMemory;
    }
    return bounded;
}

/**
 * Retains the leading rows whose serialized views fit the response byte
 * budget and elides the rest, so one call cannot inject an unbounded read
 * into the conversation. The first row always yields a view: complete when
 * it fits, field-bounded when it alone exceeds the budget.
 */
function packMemoryViews(
    rows: readonly ReadRow[],
    viewOf: (row: ReadRow) => Record<string, unknown>,
): { views: Record<string, unknown>[]; elidedRows: ReadRow[] } {
    const views: Record<string, unknown>[] = [];
    let usedBytes = 0;
    for (const [index, row] of rows.entries()) {
        const view = viewOf(row);
        const cost = Buffer.byteLength(JSON.stringify(view), "utf8");
        if (usedBytes + cost > CTX_MEMORY_RESPONSE_BUDGET_BYTES) {
            if (views.length > 0) return { views, elidedRows: rows.slice(index) };
            views.push(boundedMemoryView(row));
            return { views, elidedRows: rows.slice(index + 1) };
        }
        views.push(view);
        usedBytes += cost;
    }
    return { views, elidedRows: [] };
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
    return deriveObjectId(prefix, identity.sessionId, identity.toolCallId, prefix, `${index}`);
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

function rowCategory(row: ReadRow): string {
    return row.decision?.decision_kind ?? row.object.object_kind;
}

/** An expired anti-memory stays out of `list`, matching the surface filter search applies; `get` by explicit id still returns it so retired warnings stay inspectable and archivable. An unparseable summary never counts as expired. commentlint: allow(JUDGE) */
function isExpiredAntiMemoryRow(row: ReadRow, nowMs: number): boolean {
    if (rowCategory(row) !== ANTI_MEMORY_CATEGORY) return false;
    try {
        return antiMemoryExpired(
            parseAntiMemoryContent(row.decision?.payload.summary ?? ""),
            nowMs,
        );
    } catch {
        return false;
    }
}

/** One survivor cannot replace facts from different categories, so every merge predecessor must carry the same `decision_kind`. commentlint: allow(JUDGE) */
function requireMergeableCategory(predecessors: readonly ReadRow[]): string {
    const categories = [...new Set(predecessors.map(rowCategory))].sort();
    if (categories.length > 1) {
        throw new ClaimOperationInputError(
            `merge targets span categories (${categories.join(", ")}); one survivor cannot replace facts from different categories. Merge same-category memories only.`,
        );
    }
    return categories[0] as string;
}

/** An anti-memory records a rejected strategy; a survivor on the other arm would flip the negation, so the survivor's anti-memory arm must match the predecessors'. commentlint: allow(JUDGE) */
function requireMatchingAntiArm(survivorCategory: string, predecessorCategory: string): void {
    const survivorAnti = survivorCategory === ANTI_MEMORY_CATEGORY;
    if (survivorAnti !== (predecessorCategory === ANTI_MEMORY_CATEGORY)) {
        throw new ClaimOperationInputError(
            survivorAnti
                ? "merge cannot fold positive memories into an anti-memory survivor"
                : `merge cannot fold ${ANTI_MEMORY_CATEGORY} memories into a positive survivor; the negation would be lost`,
        );
    }
}

/** The kernel admits only the envelope's first supersede of a survivor and folds later targets in without re-admission, and an omitted sensitivity defaults to `normal`; the successor therefore asserts the strictest sensitivity any predecessor holds so a sensitive predecessor's content never reaches automatic surfaces. commentlint: allow(JUDGE) */
function strictestSensitivity(predecessors: readonly ReadRow[]): Sensitivity {
    // `SENSITIVITIES` is ordered least to most strict.
    const rank = predecessors.reduce(
        (max, row) => Math.max(max, SENSITIVITIES.indexOf(row.object.sensitivity)),
        0,
    );
    return SENSITIVITIES[rank] as Sensitivity;
}

/**
 * Every mutation target must be a memory this project can read: the daemon
 * resolves ids store-wide and checks only the tokens it is handed, so the
 * project-scoped read is the authorization boundary. Rows follow `targets`
 * order because `revisionArgs` inherits from the caller's first target. commentlint: allow(JUDGE)
 */
function requireVisible(rows: readonly ReadRow[], targets: readonly string[]): ReadRow[] {
    const byId = new Map(rows.map((row) => [row.object.object_id, row]));
    const missing = targets.filter((id) => !byId.has(id));
    if (missing.length > 0) {
        throw new ClaimOperationInputError(
            `memory not found or not visible from this project: ${missing.join(", ")}`,
        );
    }
    return targets.map((id) => byId.get(id) as ReadRow);
}

function requireTarget(args: CtxMemoryArgs): string {
    if (args.objectId !== undefined && typeof args.objectId !== "string") {
        throw new ClaimOperationInputError("'objectId' must be a string");
    }
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
    /** The host tool call's abort signal, forwarded into every daemon read and commit. */
    signal?: AbortSignal;
}

/** `objectIds` scopes the read to the named objects, so a preflight or replay probe reaches a target beyond the daemon's row cap; the listing paths read unfiltered because they need the whole snapshot. commentlint: allow(JUDGE) */
async function readMemoryRows(
    client: KernelClient,
    signal?: AbortSignal,
    objectIds?: readonly string[],
): Promise<
    | { ok: true; rows: ReadRow[]; knownAsOf: number; truncated: boolean }
    | { ok: false; state: MemoryState }
> {
    const read = await client.read({
        surface: "explicit_search",
        gated: false,
        ...(signal ? { signal } : {}),
        ...(objectIds === undefined ? {} : { objectIds }),
    });
    if (!isAvailable(read)) return { ok: false, state: read.state };
    return {
        ok: true,
        rows: read.rows.filter(isMemoryDecisionRow),
        knownAsOf: read.known_as_of,
        truncated: read.truncated,
    };
}

/** An anti-memory predecessor's summary is parsed back into an `antiMemory` payload — never inherited as `content` — because `assertCtxMemoryWriteShape` requires the payload arm for the anti-memory category. commentlint: allow(JUDGE) */
function revisionArgs(args: CtxMemoryArgs, predecessors: readonly ReadRow[]): CtxMemoryArgs {
    const decision = predecessors[0]?.decision;
    const merged: CtxMemoryArgs = {
        ...args,
        ...(args.category === undefined && decision ? { category: decision.decision_kind } : {}),
        ...(args.reason === undefined && decision?.payload.rationale
            ? { reason: decision.payload.rationale }
            : {}),
    };
    if (args.content !== undefined || args.antiMemory !== undefined || !decision) return merged;
    if (merged.category?.trim() !== ANTI_MEMORY_CATEGORY) {
        return { ...merged, content: decision.payload.summary };
    }
    try {
        return { ...merged, antiMemory: parseAntiMemoryContent(decision.payload.summary) };
    } catch {
        throw new ClaimOperationInputError(
            "the anti-memory being replaced has an unparseable stored payload; pass a full antiMemory payload to replace it",
        );
    }
}

function nextSourceRevision(predecessors: readonly ReadRow[]): number {
    return predecessors.reduce((max, row) => Math.max(max, row.object.source_revision), 0) + 1;
}

/** A `retire_decision` operation carries no payload, so the caller's reason rides in the commit intent's `cause` after the tool-call id. `cause` is audit text only — the operation key derives from the session and tool-call identity — so a redelivered call keeps its key regardless of the reason text. commentlint: allow(JUDGE) */
function archiveCause(identity: CtxMemoryWriteIdentity, reason: string | undefined): string {
    const trimmed = reason?.trim();
    return trimmed ? `${identity.toolCallId} reason: ${trimmed}` : identity.toolCallId;
}

/** The stable write identity the operation key derives from: the session scopes the harness-local tool-call id, so two sessions reusing one tool-call id key distinct operations. commentlint: allow(JUDGE) */
function operationIdOf(identity: CtxMemoryWriteIdentity): string {
    return `${identity.sessionId}${OPERATION_KEY_SEPARATOR}${identity.toolCallId}`;
}

/** A caller-supplied anti-memory without an explicit expiry gets the default horizon: kernel writes have no lifecycle expiry, so the horizon rides in the rendered payload and the read sites filter on it. The expiry is day-aligned because the rendered payload feeds the commit's request digest: a redelivered tool call must produce byte-identical operations to replay instead of hitting `operation_key_reused`. commentlint: allow(JUDGE) */
function withAntiMemoryExpiry(args: CtxMemoryArgs): CtxMemoryArgs {
    if (!args.antiMemory || args.antiMemory.expiresAt != null) return args;
    const day = 24 * 60 * 60 * 1_000;
    const expiresAt = Math.ceil((Date.now() + ANTI_MEMORY_DEFAULT_TTL_MS) / day) * day;
    return { ...args, antiMemory: { ...args.antiMemory, expiresAt } };
}

/** The create replay probe answers "already applied" only when the stored row equals the spec this request derives on its own: the derived category and rationale (empty when omitted) must equal the stored decision kind and rationale, a caller-supplied summary must equal the stored one byte for byte, and an anti-memory must re-render to the stored payload under the stored expiry — the one field a generated expiry legitimately drifts on — so any other changed content surfaces the daemon's `operation_key_reused` rejection. commentlint: allow(JUDGE) */
function replayMatchesRow(args: CtxMemoryArgs, row: ReadRow): boolean {
    const decision = row.decision;
    if (!decision) return false;
    if (decision.decision_kind !== (args.category?.trim() ?? "")) return false;
    if (decision.payload.rationale !== (args.reason?.trim() ?? "")) return false;
    if (args.antiMemory) {
        try {
            const stored = parseAntiMemoryContent(decision.payload.summary);
            const rendered = renderAntiMemoryContent({
                ...args.antiMemory,
                expiresAt: stored.expiresAt ?? null,
            });
            return rendered === decision.payload.summary;
        } catch {
            return false;
        }
    }
    if (args.content === undefined) return false;
    return decision.payload.summary === args.content.trim();
}

/** The revise and merge replay probe requires every payload field explicitly: an omitted category, content, or reason inherits from the retired predecessors, which no read serves, so the reconstructed spec is unverifiable — the probe answers no match and the ordinary path surfaces the mismatch instead of a false "already applied". commentlint: allow(JUDGE) */
function replayMatchesSuccessor(args: CtxMemoryArgs, row: ReadRow): boolean {
    const decision = row.decision;
    if (!decision) return false;
    const category = args.category?.trim();
    if (!category || decision.decision_kind !== category) return false;
    if (args.reason === undefined || decision.payload.rationale !== args.reason.trim()) {
        return false;
    }
    if (args.antiMemory) {
        return renderAntiMemoryContent(args.antiMemory) === decision.payload.summary;
    }
    if (args.content === undefined) return false;
    return decision.payload.summary === args.content.trim();
}

/** The row a redelivered revise or merge already wrote: the successor id derives from the write identity, and a committed request retired every one of its targets, so recovery requires all named targets gone. A redelivery naming a still-visible target differs from what committed and keeps the ordinary visibility error. commentlint: allow(JUDGE) */
function redeliveredSuccessor(
    args: CtxMemoryArgs,
    identity: CtxMemoryWriteIdentity,
    rows: readonly ReadRow[],
    targets: readonly string[],
): ReadRow | null {
    const present = new Set(rows.map((row) => row.object.object_id));
    if (targets.some((id) => present.has(id))) return null;
    const successor = rows.find((row) => row.object.object_id === derivedId("mem", identity, 0));
    if (!successor || !replayMatchesSuccessor(args, successor)) return null;
    return successor;
}

function renderReplayedOutcome(action: CtxMemoryAction, row: ReadRow, knownAsOf: number): string {
    return JSON.stringify({
        action,
        outcome: "already applied",
        commitSeq: row.object.created_commit_seq,
        knownAsOf,
        objectId: row.object.object_id,
        objects: [row.object.object_id],
    });
}

export async function executeCtxMemory(input: ExecuteCtxMemoryArgs): Promise<string> {
    const { client, action, identity, actor, sourceKind, signal } = input;
    const args = withAntiMemoryExpiry(input.args);
    const operationId = operationIdOf(identity);
    const mutation: MutationArgs = {
        actor,
        operationId,
        cause: identity.toolCallId,
        ...(signal ? { signal } : {}),
    };

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
        const read = await readMemoryRows(client, signal, wanted);
        if (!read.ok) return renderCtxMemoryStateText(read.state, []);
        const found = read.rows.filter((row) => wanted.includes(row.object.object_id));
        const foundIds = new Set(found.map((row) => row.object.object_id));
        const notFound = wanted.filter((id) => !foundIds.has(id));
        // Each named id serializes complete when it fits; ids past the response byte budget are elided by name so the caller can re-request them in smaller batches. commentlint: allow(JUDGE)
        const packed = packMemoryViews(found, memoryView);
        const elidedObjectIds = packed.elidedRows.map((row) => row.object.object_id);
        // A truncated read cannot prove absent ids are missing — they can live beyond the daemon's row cap — so those ids report as unresolved rather than missing. commentlint: allow(JUDGE)
        return JSON.stringify({
            action,
            knownAsOf: read.knownAsOf,
            memories: packed.views,
            ...(elidedObjectIds.length > 0
                ? {
                      elidedObjectIds,
                      elisionNote: `response byte budget reached; re-request ${elidedObjectIds.length} elided id${elidedObjectIds.length === 1 ? "" : "s"} in smaller batches`,
                  }
                : {}),
            ...(read.truncated
                ? { truncated: true, missingObjectIds: [], unresolvedObjectIds: notFound }
                : { missingObjectIds: notFound }),
        });
    }

    if (action === "list") {
        const read = await readMemoryRows(client, signal);
        if (!read.ok) return renderCtxMemoryStateText(read.state, []);
        const category = args.category?.trim();
        const nowMs = Date.now();
        const listed = read.rows
            .filter((row) => !category || row.decision?.decision_kind === category)
            .filter((row) => !isExpiredAntiMemoryRow(row, nowMs))
            .sort((left, right) => (left.object.object_id < right.object.object_id ? -1 : 1))
            .slice(0, normalizeLimit(args.limit));
        // List entries are field-bounded before packing, so a single oversized memory truncates instead of consuming the whole budget. commentlint: allow(JUDGE)
        const packed = packMemoryViews(listed, boundedMemoryView);
        return JSON.stringify({
            action,
            knownAsOf: read.knownAsOf,
            memories: packed.views,
            ...(packed.elidedRows.length > 0
                ? { elidedMemoryCount: packed.elidedRows.length }
                : {}),
            ...(read.truncated ? { truncated: true } : {}),
        });
    }

    if (action === "create") {
        const category = args.category?.trim() ?? "";
        const spec = decisionSpec(args, category, identity, {
            sourceId: CTX_MEMORY_SOURCE_ID,
            sourceRevision: 1,
        });
        const createMutation = sourceKind === undefined ? mutation : { ...mutation, sourceKind };
        const result = await client.create(spec, createMutation);
        // A generated expiry drifts across UTC day boundaries, so a call redelivered later produces a different request digest under the same operation key and the daemon answers `operation_key_reused` instead of replaying. The object id derives from the same identity, so a visible object under it proves the first delivery committed; answer the replay the daemon would have given. commentlint: allow(JUDGE)
        const generatedExpiry =
            args.antiMemory !== undefined && input.args.antiMemory?.expiresAt == null;
        if (
            generatedExpiry &&
            !isAvailable(result) &&
            result.state.kind === "invalid" &&
            result.state.reason === "operation_key_reused"
        ) {
            const read = await readMemoryRows(client, signal, [spec.object_id]);
            const existing = read.ok
                ? read.rows.find((row) => row.object.object_id === spec.object_id)
                : undefined;
            if (read.ok && existing && replayMatchesRow(args, existing)) {
                return renderReplayedOutcome(action, existing, read.knownAsOf);
            }
        }
        return renderCommit(action, result, [], spec.object_id);
    }

    if (action === "archive") {
        const target = requireTarget(args);
        const read = await readMemoryRows(client, signal, [target]);
        if (!read.ok) return renderCtxMemoryStateText(read.state, [target]);
        requireVisible(read.rows, [target]);
        return renderCommit(
            action,
            await client.archive(target, {
                actor,
                operationId,
                cause: archiveCause(identity, args.reason),
                ...(signal ? { signal } : {}),
            }),
            [target],
        );
    }

    if (action === "revise") {
        const target = requireTarget(args);
        // The successor id rides in the filter so redelivery recovery sees the row this identity already wrote. commentlint: allow(JUDGE)
        const read = await readMemoryRows(client, signal, [
            ...new Set([target, derivedId("mem", identity, 0)]),
        ]);
        if (!read.ok) return renderCtxMemoryStateText(read.state, [target]);
        // A truncated read cannot prove the target retired, so recovery only runs on a complete snapshot. commentlint: allow(JUDGE)
        const replayed = read.truncated
            ? null
            : redeliveredSuccessor(args, identity, read.rows, [target]);
        if (replayed) return renderReplayedOutcome(action, replayed, read.knownAsOf);
        const predecessors = requireVisible(read.rows, [target]);
        const merged = revisionArgs(args, predecessors);
        assertCtxMemoryWriteShape({ ...merged, action: "revise" });
        const category = merged.category?.trim();
        if (!category) {
            throw new ClaimOperationInputError(`revise requires a category for ${target}`);
        }
        const lineage = successorLineage(predecessors);
        const spec: DecisionSpecInput = {
            ...decisionSpec(merged, category, identity, {
                sourceId: lineage.sourceId,
                sourceRevision: nextSourceRevision(predecessors),
            }),
            sensitivity: strictestSensitivity(predecessors),
        };
        return renderCommit(
            action,
            await client.revise(target, spec, { ...mutation, sourceKind: lineage.sourceKind }),
            [target],
            spec.object_id,
        );
    }

    const targets = uniqueIds(args.objectIds);
    // The raw list is bounded before any per-element work so an oversized input (the schema-fallback path passes raw arguments through) is rejected without scanning. A duplicate id in the merge list is a caller-side bug; the duplicate check precedes arity validation so duplicate input cannot pass as a smaller merge after deduplication, and the error names the offending ids so the caller can fix its list. commentlint: allow(JUDGE)
    const supplied = (args.objectIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
    if (supplied.length > MERGE_MAX_TARGETS) {
        throw new ClaimOperationInputError(
            `merge accepts at most ${MERGE_MAX_TARGETS} objectIds; ${supplied.length} were given. Merge in smaller batches.`,
        );
    }
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const id of supplied) {
        if (seen.has(id)) {
            duplicates.add(id);
        } else {
            seen.add(id);
        }
    }
    if (duplicates.size > 0) {
        throw new ClaimOperationInputError(
            `merge requires distinct objectIds; duplicated: ${[...duplicates].join(", ")}`,
        );
    }
    if (targets.length < 2) {
        throw new ClaimOperationInputError("merge requires at least two objectIds");
    }
    // The successor id rides in the filter so redelivery recovery sees the row this identity already wrote. commentlint: allow(JUDGE)
    const read = await readMemoryRows(client, signal, [
        ...new Set([...targets, derivedId("mem", identity, 0)]),
    ]);
    if (!read.ok) return renderCtxMemoryStateText(read.state, targets);
    const replayed = read.truncated
        ? null
        : redeliveredSuccessor(args, identity, read.rows, targets);
    if (replayed) return renderReplayedOutcome(action, replayed, read.knownAsOf);
    const predecessors = requireVisible(read.rows, targets);
    const predecessorCategory = requireMergeableCategory(predecessors);
    const merged = revisionArgs(args, predecessors);
    assertCtxMemoryWriteShape({ ...merged, action: "revise" });
    const category = merged.category?.trim();
    if (!category) throw new ClaimOperationInputError("merge requires a category");
    requireMatchingAntiArm(category, predecessorCategory);
    const lineage = successorLineage(predecessors);
    const spec: DecisionSpecInput = {
        ...decisionSpec(merged, category, identity, {
            sourceId: lineage.sourceId,
            sourceRevision: nextSourceRevision(predecessors),
        }),
        sensitivity: strictestSensitivity(predecessors),
    };
    return renderCommit(
        action,
        await client.merge(targets, spec, { ...mutation, sourceKind: lineage.sourceKind }),
        targets,
        spec.object_id,
    );
}
