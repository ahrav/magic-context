import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { newestCtxReduceTagNumbers } from "./reclaim-protection";
import type { TagEntry } from "./types";

const insertTagStatements = new WeakMap<Database, PreparedStatement>();
const updateTagStatusStatements = new WeakMap<Database, PreparedStatement>();
const updateTagDropModeStatements = new WeakMap<Database, PreparedStatement>();
const updateTagMessageIdStatements = new WeakMap<Database, PreparedStatement>();
const getTagNumbersByMessageIdStatements = new WeakMap<Database, PreparedStatement>();
const deleteTagsByMessageIdStatements = new WeakMap<Database, PreparedStatement>();
const getMaxTagNumberBySessionStatements = new WeakMap<Database, PreparedStatement>();
const getTagNumberByMessageIdStatements = new WeakMap<Database, PreparedStatement>();
const hasPiFallbackMessageTagStatements = new WeakMap<Database, PreparedStatement>();

function getInsertTagStatement(db: Database): PreparedStatement {
    let stmt = insertTagStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, reasoning_byte_size, tag_number, tool_name, input_byte_size, harness, tool_owner_message_id, entry_fingerprint, token_count, input_token_count, reasoning_token_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        insertTagStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateTagStatusStatement(db: Database): PreparedStatement {
    let stmt = updateTagStatusStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("UPDATE tags SET status = ? WHERE session_id = ? AND tag_number = ?");
        updateTagStatusStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateTagDropModeStatement(db: Database): PreparedStatement {
    let stmt = updateTagDropModeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("UPDATE tags SET drop_mode = ? WHERE session_id = ? AND tag_number = ?");
        updateTagDropModeStatements.set(db, stmt);
    }
    return stmt;
}

const updateTagByteSizeStatements = new WeakMap<Database, PreparedStatement>();
const updateTagInputByteSizeStatements = new WeakMap<Database, PreparedStatement>();

function getUpdateTagByteSizeStatement(db: Database): PreparedStatement {
    let stmt = updateTagByteSizeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("UPDATE tags SET byte_size = ? WHERE session_id = ? AND tag_number = ?");
        updateTagByteSizeStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateTagInputByteSizeStatement(db: Database): PreparedStatement {
    let stmt = updateTagInputByteSizeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE tags SET input_byte_size = ? WHERE session_id = ? AND tag_number = ?",
        );
        updateTagInputByteSizeStatements.set(db, stmt);
    }
    return stmt;
}

/**
 *
 */
export function updateTagByteSize(
    db: Database,
    sessionId: string,
    tagNumber: number,
    newByteSize: number,
): void {
    getUpdateTagByteSizeStatement(db).run(newByteSize, sessionId, tagNumber);
}

/**
 * `MessageTokenTotal` records active-tag token totals by owning message.
 *
 * Owner derivation:
 * For message and file tags, `message_id` has the form `${msgId}:pN` or `${msgId}:fileN`.
 * The real message ID is `message_id` without its final `:pN` or `:fileN` suffix.
 *     `:p`/`:file` segment.
 *
 * `hasNull` is true when any contributing tag has a NULL `token_count`.
 */
export interface MessageTokenTotal {
    conversation: number;
    toolCall: number;
    /**
     * `toolOutput` contains only ctx_reduce-droppable tool output and excludes input-argument tokens.
     * `toolCall` equals `toolOutput` plus input-argument tokens.
     */
    toolOutput: number;
    hasNull: boolean;
}

const CONTENT_ID_SUFFIX = /:(?:p|file)\d+$/;

function ownerMessageIdForTagRow(row: {
    type: string;
    message_id: string;
    tool_owner_message_id: string | null;
}): string {
    if (row.type === "tool") {
        return row.tool_owner_message_id ?? row.message_id;
    }
    return row.message_id.replace(CONTENT_ID_SUFFIX, "");
}

/**
 * `ActiveTagTokenAggregate` records active-tag token totals for the live tail.
 *   - liveTail   = conversation + toolCall  (real user/assistant + tool I/O)
 *   - reclaimable = toolOutput              (non-dropped, ctx_reduce-droppable)
 *   - usable      = executeThresholdTokens − inputTokens + liveTail
 */
export interface ActiveTagTokenAggregate {
    conversation: number;
    toolCall: number;
    toolOutput: number;
    nullCount: number;
}

/**
 * When `protectedTags > 0`, `toolOutput` excludes the N highest active tag numbers.
 * `ctx_reduce` defers the N highest active tag numbers.
 * `toolOutput` excludes protected output so the nudge does not re-fire for output the agent cannot drop.
 * `conversation` and `toolCall` include protected content because `usable` measures the full working range.
 */
export function getActiveTagTokenAggregate(
    db: Database,
    sessionId: string,
    protectedTags = 0,
): ActiveTagTokenAggregate {
    // The cutoff is the N-th highest active tag number.
    // A tag is droppable iff its number is below the cutoff.
    // When fewer than N active tags exist, the cutoff subquery returns `NULL`.
    // When the cutoff is `NULL`, `tag_number < NULL` is never true, so reclaimable output is 0.
    const toolOutputExpr =
        protectedTags > 0
            ? `COALESCE(SUM(CASE WHEN type = 'tool' AND tag_number < (
                    SELECT tag_number FROM tags
                    WHERE session_id = ? AND status = 'active'
                    ORDER BY tag_number DESC LIMIT 1 OFFSET ?
                ) THEN COALESCE(token_count, 0) ELSE 0 END), 0)`
            : `COALESCE(SUM(CASE WHEN type = 'tool' THEN COALESCE(token_count, 0) ELSE 0 END), 0)`;
    const sql = `SELECT
                COALESCE(SUM(CASE WHEN type != 'tool' THEN COALESCE(token_count, 0) ELSE 0 END), 0)
                    + COALESCE(SUM(COALESCE(reasoning_token_count, 0)), 0) AS conversation,
                COALESCE(SUM(CASE WHEN type = 'tool' THEN COALESCE(token_count, 0) + COALESCE(input_token_count, 0) ELSE 0 END), 0) AS tool_call,
                ${toolOutputExpr} AS tool_output,
                COALESCE(SUM(CASE WHEN token_count IS NULL THEN 1 ELSE 0 END), 0) AS null_count
             FROM tags
             WHERE session_id = ? AND status = 'active'`;
    const params = protectedTags > 0 ? [sessionId, protectedTags - 1, sessionId] : [sessionId];
    const row = db.prepare(sql).get(...params) as
        | { conversation: number; tool_call: number; tool_output: number; null_count: number }
        | undefined;
    return {
        conversation: row?.conversation ?? 0,
        toolCall: row?.tool_call ?? 0,
        toolOutput: row?.tool_output ?? 0,
        nullCount: row?.null_count ?? 0,
    };
}

export interface ToolReclaimHintTag {
    tagNumber: number;
    toolName: string | null;
}

export interface AgeReclaimToolTag extends ToolReclaimHintTag {
    /** `null` means no size estimate. */
    reclaimableTokens: number | null;
}

/**
 * The hint query returns the oldest active tool tags outside the protected newest-tag window.
 */
/**
 * `todowrite` outputs contain task/plan state and are never valid reclaim hints.
 */
const RECLAIM_HINT_EXCLUDED_TOOLS = ["todowrite"] as const;

/**
 * Tags with a known combined token count below `AGE_RECLAIM_MIN_TOKENS` are excluded.
 * Tags with NULL `token_count` and `input_token_count` remain eligible because their combined size is unknown.
 */
export const AGE_RECLAIM_MIN_TOKENS = 250;

// The literal list is compile-time constant and never includes user input.
// The prepared SQL text remains static across calls.
const RECLAIM_HINT_EXCLUDED_LIST = RECLAIM_HINT_EXCLUDED_TOOLS.map(
    (name) => `'${name.replace(/'/g, "''")}'`,
).join(", ");

export function getOldestActiveUnprotectedToolTags(
    db: Database,
    sessionId: string,
    protectedTags = 0,
    limit = 4,
): ToolReclaimHintTag[] {
    if (limit <= 0) return [];
    const boundedLimit = Math.max(1, Math.min(10, Math.floor(limit)));
    const whereProtected =
        protectedTags > 0
            ? `AND tag_number < (
                    SELECT tag_number FROM tags
                    WHERE session_id = ? AND status = 'active'
                    ORDER BY tag_number DESC LIMIT 1 OFFSET ?
                )`
            : "";
    const excludeStateTools = RECLAIM_HINT_EXCLUDED_LIST
        ? `AND (tool_name IS NULL OR tool_name NOT IN (${RECLAIM_HINT_EXCLUDED_LIST}))`
        : "";
    const valueFloor = `AND (
            (token_count IS NULL AND input_token_count IS NULL)
            OR (COALESCE(token_count, 0) + COALESCE(input_token_count, 0)) >= ?
        )`;
    const params =
        protectedTags > 0
            ? [sessionId, AGE_RECLAIM_MIN_TOKENS, sessionId, protectedTags - 1, boundedLimit]
            : [sessionId, AGE_RECLAIM_MIN_TOKENS, boundedLimit];
    const rows = db
        .prepare(
            `SELECT tag_number, tool_name
             FROM tags
             WHERE session_id = ? AND status = 'active' AND type = 'tool'
             ${excludeStateTools}
             ${valueFloor}
             ${whereProtected}
             ORDER BY tag_number ASC, id ASC
             LIMIT ?`,
        )
        .all(...params) as Array<{ tag_number?: unknown; tool_name?: unknown }>;
    return rows
        .filter((row) => typeof row.tag_number === "number")
        .map((row) => ({
            tagNumber: row.tag_number as number,
            toolName: typeof row.tool_name === "string" ? row.tool_name : null,
        }));
}

const getActiveToolTagsForAgeReclaimStatements = new WeakMap<Database, PreparedStatement>();

/**
 * The function returns age-reclaim candidates with the same persisted token estimate used by reclaim hints.
 * The function omits the newest ctx_reduce exemplars.
 * Legacy rows with neither token column populated remain eligible for fail-safe reclaim.
 */
export function getActiveToolTagsForAgeReclaim(
    db: Database,
    sessionId: string,
): AgeReclaimToolTag[] {
    let stmt = getActiveToolTagsForAgeReclaimStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT tag_number, tool_name, token_count, input_token_count
             FROM tags
             WHERE session_id = ? AND status = 'active' AND type = 'tool'
             ORDER BY tag_number ASC, id ASC`,
        );
        getActiveToolTagsForAgeReclaimStatements.set(db, stmt);
    }
    const rows = stmt.all(sessionId) as Array<{
        tag_number?: unknown;
        tool_name?: unknown;
        token_count?: unknown;
        input_token_count?: unknown;
    }>;
    const tags = rows
        .filter((row) => typeof row.tag_number === "number")
        .map((row) => {
            const outputTokens = typeof row.token_count === "number" ? row.token_count : null;
            const inputTokens =
                typeof row.input_token_count === "number" ? row.input_token_count : null;
            return {
                tagNumber: row.tag_number as number,
                toolName: typeof row.tool_name === "string" ? row.tool_name : null,
                reclaimableTokens:
                    outputTokens === null && inputTokens === null
                        ? null
                        : (outputTokens ?? 0) + (inputTokens ?? 0),
            };
        });
    const protectedCtxReduceTags = newestCtxReduceTagNumbers(tags);
    return tags.filter((tag) => !protectedCtxReduceTags.has(tag.tagNumber));
}

/**
 * The sum is an upper bound on eligible historian tokens for the pre-gate.
 * The token bound is valid only when every contributing row has a cached token count.
 */
export function getTriggerTagTokenUpperBound(
    db: Database,
    sessionId: string,
    floor = 0,
): { bound: number; nullCount: number } {
    // The eligible tail is a subset of the live wire, so the scoped sum remains an upper bound.
    // Restricting the scan to `floor` excludes pre-floor rows from `nullCount`.
    const sql =
        floor > 0
            ? `SELECT
                COALESCE(SUM(COALESCE(token_count, 0) + COALESCE(input_token_count, 0) + COALESCE(reasoning_token_count, 0)), 0) AS bound,
                COALESCE(SUM(CASE WHEN token_count IS NULL THEN 1 ELSE 0 END), 0) AS null_count
             FROM tags
             WHERE session_id = ? AND status IN ('active', 'dropped') AND tag_number >= ?`
            : `SELECT
                COALESCE(SUM(COALESCE(token_count, 0) + COALESCE(input_token_count, 0) + COALESCE(reasoning_token_count, 0)), 0) AS bound,
                COALESCE(SUM(CASE WHEN token_count IS NULL THEN 1 ELSE 0 END), 0) AS null_count
             FROM tags
             WHERE session_id = ? AND status IN ('active', 'dropped')`;
    const row = (
        floor > 0 ? db.prepare(sql).get(sessionId, floor) : db.prepare(sql).get(sessionId)
    ) as { bound: number; null_count: number } | undefined;
    return { bound: row?.bound ?? 0, nullCount: row?.null_count ?? 0 };
}

export function getActiveTagTokenTotalsByMessage(
    db: Database,
    sessionId: string,
): Map<string, MessageTokenTotal> {
    const rows = db
        .prepare(
            `SELECT type, message_id, tool_owner_message_id, token_count, input_token_count, reasoning_token_count
             FROM tags
             WHERE session_id = ? AND status = 'active'`,
        )
        .all(sessionId) as Array<{
        type: string;
        message_id: string;
        tool_owner_message_id: string | null;
        token_count: number | null;
        input_token_count: number | null;
        reasoning_token_count: number | null;
    }>;
    const out = new Map<string, MessageTokenTotal>();
    for (const row of rows) {
        const owner = ownerMessageIdForTagRow(row);
        let entry = out.get(owner);
        if (!entry) {
            entry = { conversation: 0, toolCall: 0, toolOutput: 0, hasNull: false };
            out.set(owner, entry);
        }
        const reasoning = row.reasoning_token_count ?? 0;
        if (row.type === "tool") {
            const output = row.token_count ?? 0;
            entry.toolCall += output + (row.input_token_count ?? 0);
            entry.toolOutput += output;
        } else {
            entry.conversation += row.token_count ?? 0;
        }
        entry.conversation += reasoning;
        if (row.token_count === null) entry.hasNull = true;
    }
    return out;
}

/**
 * orderings).
 */
export function updateTagInputByteSize(
    db: Database,
    sessionId: string,
    tagNumber: number,
    newInputByteSize: number,
): void {
    getUpdateTagInputByteSizeStatement(db).run(newInputByteSize, sessionId, tagNumber);
}

const updateTagTokenCountStatements = new WeakMap<Database, PreparedStatement>();
const updateTagInputTokenCountStatements = new WeakMap<Database, PreparedStatement>();

function getUpdateTagTokenCountStatement(db: Database): PreparedStatement {
    let stmt = updateTagTokenCountStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE tags SET token_count = ? WHERE session_id = ? AND tag_number = ?",
        );
        updateTagTokenCountStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateTagInputTokenCountStatement(db: Database): PreparedStatement {
    let stmt = updateTagInputTokenCountStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE tags SET input_token_count = ? WHERE session_id = ? AND tag_number = ?",
        );
        updateTagInputTokenCountStatements.set(db, stmt);
    }
    return stmt;
}

/**
 */
export function updateTagTokenCount(
    db: Database,
    sessionId: string,
    tagNumber: number,
    newTokenCount: number,
): void {
    getUpdateTagTokenCountStatement(db).run(newTokenCount, sessionId, tagNumber);
}

export interface PersistedToolTagAccounting {
    byteSize: number;
    tokenCount: number | null;
    inputByteSize: number;
    inputTokenCount: number | null;
}

/* */
export function getPersistedToolTagAccounting(
    db: Database,
    sessionId: string,
    tagNumber: number,
): PersistedToolTagAccounting | null {
    const row = db
        .prepare(
            `SELECT byte_size AS byteSize,
                    token_count AS tokenCount,
                    input_byte_size AS inputByteSize,
                    input_token_count AS inputTokenCount
             FROM tags
             WHERE session_id = ? AND tag_number = ? AND type = 'tool'`,
        )
        .get(sessionId, tagNumber) as PersistedToolTagAccounting | null | undefined;
    if (
        !row ||
        typeof row.byteSize !== "number" ||
        (row.tokenCount !== null && typeof row.tokenCount !== "number") ||
        typeof row.inputByteSize !== "number" ||
        (row.inputTokenCount !== null && typeof row.inputTokenCount !== "number")
    ) {
        return null;
    }
    return row;
}

/**
 * The function maps each real message ID to its original token total for the protected-tail boundary.
 * The boundary includes reasoning tokens regardless of drop status because it uses original content.
 *
 * Messages with a null tag token_count are omitted so the boundary retokenizes them.
 * Pre-boundary (`compacted`) messages cancel out of the boundary's prefix-difference math.
 * Pre-boundary (`compacted`) messages cancel out of the boundary's prefix-difference math, so including them is harmless.
 */
export function getAllStatusTagTokenTotalsFlat(
    db: Database,
    sessionId: string,
    floor = 0,
): { totals: Map<string, number>; nullMessageIds: Set<string> } {
    // tag_number is monotonic with message order.
    // Tags below the first wire message are compacted history that the boundary never indexes.
    const rows = (
        floor > 0
            ? db
                  .prepare(
                      `SELECT type, message_id, tool_owner_message_id, token_count, input_token_count, reasoning_token_count
                       FROM tags
                       WHERE session_id = ? AND tag_number >= ?`,
                  )
                  .all(sessionId, floor)
            : db
                  .prepare(
                      `SELECT type, message_id, tool_owner_message_id, token_count, input_token_count, reasoning_token_count
                       FROM tags
                       WHERE session_id = ?`,
                  )
                  .all(sessionId)
    ) as Array<{
        type: string;
        message_id: string;
        tool_owner_message_id: string | null;
        token_count: number | null;
        input_token_count: number | null;
        reasoning_token_count: number | null;
    }>;
    const totals = new Map<string, number>();
    const nullMessageIds = new Set<string>();
    for (const row of rows) {
        // NULL-owner tool rows cannot be attributed to a real message id.
        // NULL-owner tool rows would be keyed by bare callId values that storedTotalForMessage never queries.
        // A NULL owner cannot identify a message to mark NULL.
        if (row.type === "tool" && row.tool_owner_message_id === null) continue;
        const owner = ownerMessageIdForTagRow(row);
        if (row.token_count === null) {
            nullMessageIds.add(owner);
            totals.delete(owner);
            continue;
        }
        if (nullMessageIds.has(owner)) continue;
        const weight =
            (row.token_count ?? 0) +
            (row.input_token_count ?? 0) +
            (row.reasoning_token_count ?? 0);
        totals.set(owner, (totals.get(owner) ?? 0) + weight);
    }
    return { totals, nullMessageIds };
}

/* */
export function updateTagInputTokenCount(
    db: Database,
    sessionId: string,
    tagNumber: number,
    newInputTokenCount: number,
): void {
    getUpdateTagInputTokenCountStatement(db).run(newInputTokenCount, sessionId, tagNumber);
}

/**
 * `NULL` token_count requires backfill.
 */
export function tagTokenCountIsNull(db: Database, sessionId: string, tagNumber: number): boolean {
    const row = db
        .prepare("SELECT token_count FROM tags WHERE session_id = ? AND tag_number = ?")
        .get(sessionId, tagNumber) as { token_count: number | null } | undefined | null;
    return row != null && row.token_count === null;
}

/**
 * Backfill legacy token columns only while `token_count` is NULL.
 * `token_count IS NULL` prevents backfill from overwriting a non-NULL token count.
 * insert time.
 */
export function backfillTagTokenCounts(
    db: Database,
    sessionId: string,
    tagNumber: number,
    counts: TagTokenCounts,
): void {
    db.prepare(
        `UPDATE tags
            SET token_count = ?, input_token_count = ?, reasoning_token_count = ?
            WHERE session_id = ? AND tag_number = ? AND token_count IS NULL`,
    ).run(
        counts.tokenCount ?? null,
        counts.inputTokenCount ?? null,
        counts.reasoningTokenCount ?? null,
        sessionId,
        tagNumber,
    );
}

function getUpdateTagMessageIdStatement(db: Database): PreparedStatement {
    let stmt = updateTagMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("UPDATE tags SET message_id = ? WHERE session_id = ? AND tag_number = ?");
        updateTagMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

function getTagNumbersByMessageIdStatement(db: Database): PreparedStatement {
    let stmt = getTagNumbersByMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT tag_number FROM tags WHERE session_id = ? AND (message_id = ? OR message_id LIKE ? ESCAPE '\\' OR message_id LIKE ? ESCAPE '\\') ORDER BY tag_number ASC",
        );
        getTagNumbersByMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteTagsByMessageIdStatement(db: Database): PreparedStatement {
    let stmt = deleteTagsByMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "DELETE FROM tags WHERE session_id = ? AND (message_id = ? OR message_id LIKE ? ESCAPE '\\' OR message_id LIKE ? ESCAPE '\\')",
        );
        deleteTagsByMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

function getMaxTagNumberBySessionStatement(db: Database): PreparedStatement {
    let stmt = getMaxTagNumberBySessionStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT COALESCE(MAX(tag_number), 0) AS max_tag_number FROM tags WHERE session_id = ?",
        );
        getMaxTagNumberBySessionStatements.set(db, stmt);
    }
    return stmt;
}

function getTagNumberByMessageIdStatement(db: Database): PreparedStatement {
    let stmt = getTagNumberByMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT tag_number FROM tags WHERE session_id = ? AND message_id = ? ORDER BY tag_number ASC LIMIT 1",
        );
        getTagNumberByMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

interface TagRow {
    id: number;
    message_id: string;
    type: string;
    status: string;
    drop_mode: string | null;
    tool_name: string | null;
    input_byte_size: number | null;
    byte_size: number;
    reasoning_byte_size: number;
    session_id: string;
    tag_number: number;
    caveman_depth: number | null;
    tool_owner_message_id: string | null;
}

interface TagNumberRow {
    tag_number: number;
}

interface MaxTagNumberRow {
    max_tag_number: number;
}

function isTagRow(row: unknown): row is TagRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.id === "number" &&
        typeof r.message_id === "string" &&
        typeof r.type === "string" &&
        typeof r.status === "string" &&
        typeof r.byte_size === "number" &&
        typeof r.session_id === "string" &&
        typeof r.tag_number === "number"
    );
}

function toTagEntry(row: TagRow): TagEntry {
    const type = row.type === "tool" ? "tool" : row.type === "file" ? "file" : "message";
    const status = row.status === "dropped" || row.status === "compacted" ? row.status : "active";

    return {
        tagNumber: row.tag_number,
        messageId: row.message_id,
        type,
        status,
        dropMode:
            row.drop_mode === "truncated"
                ? "truncated"
                : row.drop_mode === "edit_marker"
                  ? "edit_marker"
                  : "full",
        toolName: row.tool_name ?? null,
        inputByteSize: row.input_byte_size ?? 0,
        byteSize: row.byte_size,
        reasoningByteSize: row.reasoning_byte_size ?? 0,
        sessionId: row.session_id,
        cavemanDepth:
            typeof row.caveman_depth === "number" && Number.isFinite(row.caveman_depth)
                ? row.caveman_depth
                : 0,
        toolOwnerMessageId:
            typeof row.tool_owner_message_id === "string" ? row.tool_owner_message_id : null,
    };
}

function isTagNumberRow(row: unknown): row is TagNumberRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.tag_number === "number";
}

function isMaxTagNumberRow(row: unknown): row is MaxTagNumberRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.max_tag_number === "number";
}

function escapeLikePattern(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/**
 */
export interface TagTokenCounts {
    tokenCount: number | null;
    inputTokenCount: number | null;
    reasoningTokenCount: number | null;
}

export function insertTag(
    db: Database,
    sessionId: string,
    messageId: string,
    type: TagEntry["type"],
    byteSize: number,
    tagNumber: number,
    reasoningByteSize: number = 0,
    toolName: string | null = null,
    inputByteSize: number = 0,
    toolOwnerMessageId: string | null = null,
    entryFingerprint: string | null = null,
    tokenCounts: TagTokenCounts | null = null,
): number {
    getInsertTagStatement(db).run(
        sessionId,
        messageId,
        type,
        byteSize,
        reasoningByteSize,
        tagNumber,
        toolName,
        inputByteSize,
        getHarness(),
        toolOwnerMessageId,
        entryFingerprint,
        tokenCounts?.tokenCount ?? null,
        tokenCounts?.inputTokenCount ?? null,
        tokenCounts?.reasoningTokenCount ?? null,
    );

    return tagNumber;
}

export function updateTagStatus(
    db: Database,
    sessionId: string,
    tagId: number,
    status: TagEntry["status"],
): void {
    getUpdateTagStatusStatement(db).run(status, sessionId, tagId);
}

export function updateTagDropMode(
    db: Database,
    sessionId: string,
    tagNumber: number,
    dropMode: TagEntry["dropMode"],
): void {
    getUpdateTagDropModeStatement(db).run(dropMode, sessionId, tagNumber);
}

/**
 *
 */
export function updateCavemanDepth(
    db: Database,
    sessionId: string,
    tagNumber: number,
    depth: number,
): void {
    db.prepare("UPDATE tags SET caveman_depth = ? WHERE session_id = ? AND tag_number = ?").run(
        depth,
        sessionId,
        tagNumber,
    );
}

export function updateTagMessageId(
    db: Database,
    sessionId: string,
    tagId: number,
    messageId: string,
): void {
    getUpdateTagMessageIdStatement(db).run(messageId, sessionId, tagId);
}

/* */
export function hasPiFallbackMessageTags(db: Database, sessionId: string): boolean {
    let statement = hasPiFallbackMessageTagStatements.get(db);
    if (!statement) {
        statement = db.prepare(
            `SELECT 1
             FROM tags
             WHERE session_id = ?
               AND type = 'message'
               AND message_id LIKE 'pi-msg-%'
             LIMIT 1`,
        );
        hasPiFallbackMessageTagStatements.set(db, statement);
    }
    return statement.get(sessionId) != null;
}

/**
 * The lookup selects message tags under `pi-msg-*` fallback IDs for migration to real SessionEntry IDs.
 * The caller applies per-part uniqueness checks and race-safe migration to each candidate.
 * `type = 'message'` and fallback-ID matching exclude real-ID rows from re-adoption.
 */
export function findAdoptableFallbackTags(
    db: Database,
    sessionId: string,
    entryFingerprint: string,
): Array<{ tagNumber: number; messageId: string }> {
    const rows = db
        .prepare(
            `SELECT tag_number AS tagNumber, message_id AS messageId
             FROM tags
             WHERE session_id = ?
               AND type = 'message'
               AND entry_fingerprint = ?
               AND message_id LIKE 'pi-msg-%'`,
        )
        .all(sessionId, entryFingerprint) as Array<{ tagNumber: number; messageId: string }>;
    return rows;
}

/**
 * `WHERE message_id = oldMessageId` prevents overwriting a row re-keyed by another process.
 * If another process re-keys the row first, the guarded update affects zero rows.
 */
export function adoptFallbackTagMessageId(
    db: Database,
    sessionId: string,
    tagNumber: number,
    oldFallbackMessageId: string,
    newRealMessageId: string,
): boolean {
    const result = db
        .prepare(
            `UPDATE tags SET message_id = ?
             WHERE session_id = ? AND tag_number = ? AND message_id = ?`,
        )
        .run(newRealMessageId, sessionId, tagNumber, oldFallbackMessageId);
    return (result.changes ?? 0) > 0;
}

export interface PiFallbackToolOwnerTag {
    tagNumber: number;
    callId: string;
    toolOwnerMessageId: string;
    status: string;
}

export type PiFallbackTagAdoptionResult =
    | { action: "skipped" }
    | { action: "rekeyed"; tagNumber: number }
    | { action: "folded"; tagNumber: number; deletedTagNumbers: number[] };

interface PiFallbackFoldTagRow {
    tagNumber: number;
    messageId: string;
    toolOwnerMessageId: string | null;
    type: string;
    status: string;
    byteSize: number | null;
    reasoningByteSize: number | null;
    inputByteSize: number | null;
    tokenCount: number | null;
    inputTokenCount: number | null;
    reasoningTokenCount: number | null;
}

interface PendingOpIdentityRow {
    id: number;
    operation: string;
}

function isPiFallbackToolOwnerTag(row: unknown): row is PiFallbackToolOwnerTag {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.tagNumber === "number" &&
        typeof r.callId === "string" &&
        typeof r.toolOwnerMessageId === "string" &&
        typeof r.status === "string"
    );
}

function isPiFallbackFoldTagRow(row: unknown): row is PiFallbackFoldTagRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.tagNumber === "number" &&
        typeof r.messageId === "string" &&
        (typeof r.toolOwnerMessageId === "string" || r.toolOwnerMessageId === null) &&
        typeof r.type === "string" &&
        typeof r.status === "string" &&
        (typeof r.byteSize === "number" || r.byteSize === null) &&
        (typeof r.reasoningByteSize === "number" || r.reasoningByteSize === null) &&
        (typeof r.inputByteSize === "number" || r.inputByteSize === null) &&
        (typeof r.tokenCount === "number" || r.tokenCount === null) &&
        (typeof r.inputTokenCount === "number" || r.inputTokenCount === null) &&
        (typeof r.reasoningTokenCount === "number" || r.reasoningTokenCount === null)
    );
}

function isPendingOpIdentityRow(row: unknown): row is PendingOpIdentityRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.id === "number" && typeof r.operation === "string";
}

function maxNullableNumber(a: number | null, b: number | null): number | null {
    if (typeof a === "number" && typeof b === "number") return Math.max(a, b);
    if (typeof a === "number") return a;
    if (typeof b === "number") return b;
    return null;
}

function getPiFallbackFoldTagRowByNumber(
    db: Database,
    sessionId: string,
    tagNumber: number,
): PiFallbackFoldTagRow | null {
    const row = db
        .prepare(
            `SELECT tag_number AS tagNumber,
                    message_id AS messageId,
                    tool_owner_message_id AS toolOwnerMessageId,
                    type,
                    status,
                    byte_size AS byteSize,
                    reasoning_byte_size AS reasoningByteSize,
                    input_byte_size AS inputByteSize,
                    token_count AS tokenCount,
                    input_token_count AS inputTokenCount,
                    reasoning_token_count AS reasoningTokenCount
             FROM tags
             WHERE session_id = ? AND tag_number = ?`,
        )
        .get(sessionId, tagNumber);
    return isPiFallbackFoldTagRow(row) ? row : null;
}

function getPiFallbackToolFoldTagRowByOwner(
    db: Database,
    sessionId: string,
    callId: string,
    ownerMsgId: string,
): PiFallbackFoldTagRow | null {
    const row = db
        .prepare(
            `SELECT tag_number AS tagNumber,
                    message_id AS messageId,
                    tool_owner_message_id AS toolOwnerMessageId,
                    type,
                    status,
                    byte_size AS byteSize,
                    reasoning_byte_size AS reasoningByteSize,
                    input_byte_size AS inputByteSize,
                    token_count AS tokenCount,
                    input_token_count AS inputTokenCount,
                    reasoning_token_count AS reasoningTokenCount
             FROM tags
             WHERE session_id = ?
               AND message_id = ?
               AND type = 'tool'
               AND tool_owner_message_id = ?
             LIMIT 1`,
        )
        .get(sessionId, callId, ownerMsgId);
    return isPiFallbackFoldTagRow(row) ? row : null;
}

function getPiFallbackMessageFoldTagRowsByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): PiFallbackFoldTagRow[] {
    return db
        .prepare(
            `SELECT tag_number AS tagNumber,
                    message_id AS messageId,
                    tool_owner_message_id AS toolOwnerMessageId,
                    type,
                    status,
                    byte_size AS byteSize,
                    reasoning_byte_size AS reasoningByteSize,
                    input_byte_size AS inputByteSize,
                    token_count AS tokenCount,
                    input_token_count AS inputTokenCount,
                    reasoning_token_count AS reasoningTokenCount
             FROM tags
             WHERE session_id = ?
               AND message_id = ?
               AND type = 'message'
             ORDER BY tag_number ASC`,
        )
        .all(sessionId, messageId)
        .filter(isPiFallbackFoldTagRow);
}

function mergeSizeAndTokenColumnsIntoSurvivor(
    db: Database,
    sessionId: string,
    survivor: PiFallbackFoldTagRow,
    duplicate: PiFallbackFoldTagRow,
): void {
    db.prepare(
        `UPDATE tags
         SET byte_size = ?,
             reasoning_byte_size = ?,
             input_byte_size = ?,
             token_count = ?,
             input_token_count = ?,
             reasoning_token_count = ?
         WHERE session_id = ? AND tag_number = ?`,
    ).run(
        maxNullableNumber(survivor.byteSize, duplicate.byteSize),
        maxNullableNumber(survivor.reasoningByteSize, duplicate.reasoningByteSize),
        maxNullableNumber(survivor.inputByteSize, duplicate.inputByteSize),
        maxNullableNumber(survivor.tokenCount, duplicate.tokenCount),
        maxNullableNumber(survivor.inputTokenCount, duplicate.inputTokenCount),
        maxNullableNumber(survivor.reasoningTokenCount, duplicate.reasoningTokenCount),
        sessionId,
        survivor.tagNumber,
    );
    survivor.byteSize = maxNullableNumber(survivor.byteSize, duplicate.byteSize);
    survivor.reasoningByteSize = maxNullableNumber(
        survivor.reasoningByteSize,
        duplicate.reasoningByteSize,
    );
    survivor.inputByteSize = maxNullableNumber(survivor.inputByteSize, duplicate.inputByteSize);
    survivor.tokenCount = maxNullableNumber(survivor.tokenCount, duplicate.tokenCount);
    survivor.inputTokenCount = maxNullableNumber(
        survivor.inputTokenCount,
        duplicate.inputTokenCount,
    );
    survivor.reasoningTokenCount = maxNullableNumber(
        survivor.reasoningTokenCount,
        duplicate.reasoningTokenCount,
    );
}

function applyDroppedStatusIfNeeded(
    db: Database,
    sessionId: string,
    survivor: PiFallbackFoldTagRow,
    duplicate: PiFallbackFoldTagRow,
): void {
    if (survivor.status === "dropped") return;
    if (duplicate.status !== "dropped") return;
    db.prepare("UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?").run(
        sessionId,
        survivor.tagNumber,
    );
    survivor.status = "dropped";
}

function retargetPendingOps(
    db: Database,
    sessionId: string,
    fromTagNumber: number,
    toTagNumber: number,
): void {
    const rows = db
        .prepare(
            `SELECT id, operation
             FROM pending_ops
             WHERE session_id = ? AND tag_id = ?
             ORDER BY id ASC`,
        )
        .all(sessionId, fromTagNumber)
        .filter(isPendingOpIdentityRow);
    for (const row of rows) {
        const existing = db
            .prepare(
                `SELECT 1
                 FROM pending_ops
                 WHERE session_id = ? AND tag_id = ? AND operation = ?
                 LIMIT 1`,
            )
            .get(sessionId, toTagNumber, row.operation);
        if (existing) {
            db.prepare("DELETE FROM pending_ops WHERE session_id = ? AND id = ?").run(
                sessionId,
                row.id,
            );
        } else {
            db.prepare("UPDATE pending_ops SET tag_id = ? WHERE session_id = ? AND id = ?").run(
                toTagNumber,
                sessionId,
                row.id,
            );
        }
    }
    db.prepare("DELETE FROM pending_ops WHERE session_id = ? AND tag_id = ?").run(
        sessionId,
        fromTagNumber,
    );
}

function deleteFoldedDuplicateTag(db: Database, sessionId: string, tagNumber: number): void {
    db.prepare("DELETE FROM source_contents WHERE session_id = ? AND tag_id = ?").run(
        sessionId,
        tagNumber,
    );
    db.prepare("DELETE FROM tags WHERE session_id = ? AND tag_number = ?").run(
        sessionId,
        tagNumber,
    );
    db.prepare("DELETE FROM pending_ops WHERE session_id = ? AND tag_id = ?").run(
        sessionId,
        tagNumber,
    );
}

function foldDuplicateIntoSurvivor(
    db: Database,
    sessionId: string,
    survivor: PiFallbackFoldTagRow,
    duplicate: PiFallbackFoldTagRow,
): void {
    mergeSizeAndTokenColumnsIntoSurvivor(db, sessionId, survivor, duplicate);
    applyDroppedStatusIfNeeded(db, sessionId, survivor, duplicate);
    retargetPendingOps(db, sessionId, duplicate.tagNumber, survivor.tagNumber);
    deleteFoldedDuplicateTag(db, sessionId, duplicate.tagNumber);
}

export function hasPiFallbackToolOwnerTags(db: Database, sessionId: string): boolean {
    const row = db
        .prepare(
            `SELECT 1
             FROM tags
             WHERE session_id = ?
               AND type = 'tool'
               AND tool_owner_message_id LIKE 'pi-msg-%'
             LIMIT 1`,
        )
        .get(sessionId);
    // `row != null` treats both `null` and `undefined` as no row.
    return row != null;
}

export function findPiFallbackToolOwnerTags(
    db: Database,
    sessionId: string,
): PiFallbackToolOwnerTag[] {
    return db
        .prepare(
            `SELECT tag_number AS tagNumber,
                    message_id AS callId,
                    tool_owner_message_id AS toolOwnerMessageId,
                    status
             FROM tags
             WHERE session_id = ?
               AND type = 'tool'
               AND tool_owner_message_id LIKE 'pi-msg-%'
             ORDER BY tag_number ASC`,
        )
        .all(sessionId)
        .filter(isPiFallbackToolOwnerTag);
}

export function adoptPiFallbackToolOwnerTag(
    db: Database,
    sessionId: string,
    tagNumber: number,
    callId: string,
    oldOwnerMessageId: string,
    newOwnerMessageId: string,
): PiFallbackTagAdoptionResult {
    const survivor = getPiFallbackFoldTagRowByNumber(db, sessionId, tagNumber);
    if (
        survivor === null ||
        survivor.type !== "tool" ||
        survivor.messageId !== callId ||
        survivor.toolOwnerMessageId !== oldOwnerMessageId
    ) {
        return { action: "skipped" };
    }

    const existing = getPiFallbackToolFoldTagRowByOwner(db, sessionId, callId, newOwnerMessageId);
    if (existing === null) {
        const result = db
            .prepare(
                `UPDATE tags
                 SET tool_owner_message_id = ?
                 WHERE session_id = ?
                   AND tag_number = ?
                   AND type = 'tool'
                   AND message_id = ?
                   AND tool_owner_message_id = ?`,
            )
            .run(newOwnerMessageId, sessionId, tagNumber, callId, oldOwnerMessageId);
        return (result.changes ?? 0) === 1
            ? { action: "rekeyed", tagNumber }
            : { action: "skipped" };
    }

    if (existing.tagNumber === tagNumber) {
        return { action: "skipped" };
    }

    // A racing pass can allocate the real-id row after adoption.
    foldDuplicateIntoSurvivor(db, sessionId, existing, survivor);
    return {
        action: "folded",
        tagNumber: existing.tagNumber,
        deletedTagNumbers: [tagNumber],
    };
}

export function adoptPiFallbackMessageTag(
    db: Database,
    sessionId: string,
    tagNumber: number,
    oldFallbackMessageId: string,
    newRealMessageId: string,
): PiFallbackTagAdoptionResult {
    const survivor = getPiFallbackFoldTagRowByNumber(db, sessionId, tagNumber);
    if (
        survivor === null ||
        survivor.type !== "message" ||
        survivor.messageId !== oldFallbackMessageId
    ) {
        return { action: "skipped" };
    }

    const duplicates = getPiFallbackMessageFoldTagRowsByMessageId(
        db,
        sessionId,
        newRealMessageId,
    ).filter((row) => row.tagNumber !== tagNumber);
    if (duplicates.length === 0) {
        const result = db
            .prepare(
                `UPDATE tags
                 SET message_id = ?
                 WHERE session_id = ?
                   AND tag_number = ?
                   AND type = 'message'
                   AND message_id = ?`,
            )
            .run(newRealMessageId, sessionId, tagNumber, oldFallbackMessageId);
        return (result.changes ?? 0) === 1
            ? { action: "rekeyed", tagNumber }
            : { action: "skipped" };
    }

    // The migration preserves the real-ID row's tag number and merges the fallback row into it.
    const realSurvivor = duplicates[0];
    if (!realSurvivor) return { action: "skipped" };
    const deletedTagNumbers = [tagNumber];
    foldDuplicateIntoSurvivor(db, sessionId, realSurvivor, survivor);
    for (const duplicate of duplicates.slice(1)) {
        foldDuplicateIntoSurvivor(db, sessionId, realSurvivor, duplicate);
        deletedTagNumbers.push(duplicate.tagNumber);
    }
    return {
        action: "folded",
        tagNumber: realSurvivor.tagNumber,
        deletedTagNumbers,
    };
}

/**
 *
 *     `<removed-msg-id>:file%`.
 *
 * Tool tags store the call ID in `messageId`, so removal must match `tool_owner_message_id`.
 *
 */
export function deleteTagsByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): number[] {
    const deleteTransaction = db.transaction(() => {
        const escapedMessageId = escapeLikePattern(messageId);
        const textPartPattern = `${escapedMessageId}:p%`;
        const filePartPattern = `${escapedMessageId}:file%`;
        const messageScopedTags = getTagNumbersByMessageIdStatement(db)
            .all(sessionId, messageId, textPartPattern, filePartPattern)
            .filter(isTagNumberRow)
            .map((row) => row.tag_number);

        // Collect matching tag numbers before deletion so the caller can receive them.
        // the union.
        const ownerScopedTagNumbers = getOwnerScopedToolTagNumbers(db, sessionId, messageId);

        if (messageScopedTags.length === 0 && ownerScopedTagNumbers.length === 0) {
            return [];
        }

        if (messageScopedTags.length > 0) {
            getDeleteTagsByMessageIdStatement(db).run(
                sessionId,
                messageId,
                textPartPattern,
                filePartPattern,
            );
        }
        if (ownerScopedTagNumbers.length > 0) {
            deleteToolTagsByOwner(db, sessionId, messageId);
        }

        // Deduplicate matching tag numbers because one tag can match both predicates.
        const merged = new Set<number>([...messageScopedTags, ...ownerScopedTagNumbers]);
        return Array.from(merged).sort((a, b) => a - b);
    });
    return deleteTransaction.immediate();
}

const getOwnerScopedToolTagNumbersStatements = new WeakMap<Database, PreparedStatement>();
function getOwnerScopedToolTagNumbers(
    db: Database,
    sessionId: string,
    ownerMsgId: string,
): number[] {
    let stmt = getOwnerScopedToolTagNumbersStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' AND tool_owner_message_id = ? ORDER BY tag_number ASC",
        );
        getOwnerScopedToolTagNumbersStatements.set(db, stmt);
    }
    return stmt
        .all(sessionId, ownerMsgId)
        .filter(isTagNumberRow)
        .map((row) => row.tag_number);
}

export function getMaxTagNumberBySession(db: Database, sessionId: string): number {
    const row = getMaxTagNumberBySessionStatement(db).get(sessionId);
    return isMaxTagNumberRow(row) ? row.max_tag_number : 0;
}

/**
 *
 * Returns null when no tag exists for that message.
 */
export function getTagNumberByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): number | null {
    const row = getTagNumberByMessageIdStatement(db).get(sessionId, messageId);
    return isTagNumberRow(row) ? row.tag_number : null;
}

const getMinMessageTagNumberForRawIdStatements = new WeakMap<Database, PreparedStatement>();
interface MinTagNumberRow {
    m: number | null;
}
function isMinTagNumberRow(row: unknown): row is MinTagNumberRow {
    return row !== null && typeof row === "object" && "m" in row;
}
/**
 * Returns the lowest `tag_number` among message/file content IDs for one raw message ID.
 *
 * Message and file tags use `${rawId}:p${n}` and `${rawId}:file${n}` content IDs.
 * The half-open range `[rawId + ':', rawId + ';')` selects only `rawId` content IDs.
 * `:` (0x3A) is the field separator, and `;` (0x3B) is its immediate successor.
 * `rawId` prefixes sort before `${rawId}:`; the upper bound excludes IDs at or after `${rawId};`.
 * The range avoids LIKE wildcard escaping.
 * The range excludes tool tags because their `messageId` is a call ID, not a raw-ID content ID.
 *
 * Returns null when `rawId` has no message/file tag.
 * The function returns null when `rawId` contains `:` because that would invalidate the delimiter range.
 */
export function getMinMessageTagNumberForRawId(
    db: Database,
    sessionId: string,
    rawId: string,
): number | null {
    if (rawId.includes(":")) return null;
    let stmt = getMinMessageTagNumberForRawIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT MIN(tag_number) AS m FROM tags WHERE session_id = ? AND message_id >= ? AND message_id < ?",
        );
        getMinMessageTagNumberForRawIdStatements.set(db, stmt);
    }
    const row = stmt.get(sessionId, `${rawId}:`, `${rawId};`);
    return isMinTagNumberRow(row) && typeof row.m === "number" ? row.m : null;
}

// A lower floor loads more tags and cannot exclude an in-wire tag.
// Taking the minimum across resolved messages absorbs head reordering.
// TAGGER_FLOOR_MAX_PROBES caps probes so a ghost- or tool-only head cannot scan the entire wire.
// If no probe resolves, return floor 0 for a full scan.
// The margin includes tags immediately preceding the first resolved message.
export const TAGGER_FLOOR_SCAN_MESSAGES = 8; // SCAN_HITS
export const TAGGER_FLOOR_MAX_PROBES = 64;
export const TAGGER_FLOOR_SAFETY_MARGIN = 256;
export const TAGGER_FLOOR_PER_SKIP_MARGIN = 64;

/**
 * Clamping at 0 preserves 0 as the full-session floor.
 * The tagger and compartment trigger use the same floor to scope their live-wire tag scans.
 *
 *
 */
export function deriveTagLoadFloor(
    db: Database,
    sessionId: string,
    rawIds: Iterable<string | null | undefined>,
): number {
    let min = Number.POSITIVE_INFINITY;
    let probes = 0;
    let hits = 0;
    let skippedBeforeFirstHit = 0;
    for (const rawId of rawIds) {
        if (typeof rawId !== "string" || rawId.length === 0) continue;
        if (probes >= TAGGER_FLOOR_MAX_PROBES) break;
        probes++;
        const m = getMinMessageTagNumberForRawId(db, sessionId, rawId);
        if (m === null) {
            if (hits === 0) skippedBeforeFirstHit++;
            continue;
        }
        if (m < min) min = m;
        if (++hits >= TAGGER_FLOOR_SCAN_MESSAGES) break;
    }
    if (!Number.isFinite(min)) return 0;
    const margin =
        TAGGER_FLOOR_SAFETY_MARGIN + skippedBeforeFirstHit * TAGGER_FLOOR_PER_SKIP_MARGIN;
    return Math.max(0, min - margin);
}

// `TAG_SELECT_COLUMNS` must include every column read by `toTagEntry`.
const TAG_SELECT_COLUMNS =
    "id, message_id, type, status, drop_mode, tool_name, input_byte_size, byte_size, reasoning_byte_size, session_id, tag_number, caveman_depth, tool_owner_message_id";

export function getTagsBySession(db: Database, sessionId: string): TagEntry[] {
    const rows = db
        .prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? ORDER BY tag_number ASC, id ASC`,
        )
        .all(sessionId)
        .filter(isTagRow);

    return rows.map(toTagEntry);
}

//
//
//

const getActiveTagsBySessionStatements = new WeakMap<Database, PreparedStatement>();
const getNullOwnerToolTagsBySessionStatements = new WeakMap<Database, PreparedStatement>();
const getDroppedTagsBySessionStatements = new WeakMap<Database, PreparedStatement>();
const getMaxDroppedTagNumberStatements = new WeakMap<Database, PreparedStatement>();

function getActiveTagsBySessionStatement(db: Database): PreparedStatement {
    let stmt = getActiveTagsBySessionStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND status = 'active' ORDER BY tag_number ASC, id ASC`,
        );
        getActiveTagsBySessionStatements.set(db, stmt);
    }
    return stmt;
}

function getDroppedTagsBySessionStatement(db: Database): PreparedStatement {
    let stmt = getDroppedTagsBySessionStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND status = 'dropped' ORDER BY tag_number ASC, id ASC`,
        );
        getDroppedTagsBySessionStatements.set(db, stmt);
    }
    return stmt;
}

function getMaxDroppedTagNumberStatement(db: Database): PreparedStatement {
    let stmt = getMaxDroppedTagNumberStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT COALESCE(MAX(tag_number), 0) AS max_tag_number FROM tags WHERE session_id = ? AND status = 'dropped'",
        );
        getMaxDroppedTagNumberStatements.set(db, stmt);
    }
    return stmt;
}

/**
 *
 *
 * `getTagsBySession`.
 *
 */
export function getActiveTagsBySession(db: Database, sessionId: string): TagEntry[] {
    const rows = getActiveTagsBySessionStatement(db).all(sessionId).filter(isTagRow);
    return rows.map(toTagEntry);
}

/**
 * getTailHygieneTags returns tags used for final rendered-tail accounting.
 * Tool tags with no owner are included regardless of status.
 */
export function getTailHygieneTags(db: Database, sessionId: string): TagEntry[] {
    const active = getActiveTagsBySession(db, sessionId);
    let orphanStatement = getNullOwnerToolTagsBySessionStatements.get(db);
    if (!orphanStatement) {
        orphanStatement = db.prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags
             WHERE session_id = ? AND type = 'tool' AND tool_owner_message_id IS NULL
             ORDER BY tag_number ASC, id ASC`,
        );
        getNullOwnerToolTagsBySessionStatements.set(db, orphanStatement);
    }
    const seen = new Set(active.map((tag) => `${tag.tagNumber}\0${tag.messageId}\0${tag.type}`));
    for (const row of orphanStatement.all(sessionId).filter(isTagRow)) {
        const orphan = toTagEntry(row);
        const key = `${orphan.tagNumber}\0${orphan.messageId}\0${orphan.type}`;
        if (!seen.has(key)) active.push(orphan);
    }
    return active;
}

/**
 */
export function getDroppedTagsBySession(db: Database, sessionId: string): TagEntry[] {
    const rows = getDroppedTagsBySessionStatement(db).all(sessionId).filter(isTagRow);
    return rows.map(toTagEntry);
}

/**
 *
 *
 *
 */
export function getTagsForPendingOperations(
    db: Database,
    sessionId: string,
    pendingTagNumbers: readonly number[],
    protectedTags: number,
    recentToolWindow: number,
): TagEntry[] {
    const byNumber = new Map<number, TagEntry>();
    for (const tag of getTagsByNumbers(db, sessionId, pendingTagNumbers)) {
        byNumber.set(tag.tagNumber, tag);
    }
    const addRows = (sql: string, limit: number): void => {
        if (limit <= 0) return;
        const rows = db.prepare(sql).all(sessionId, limit).filter(isTagRow);
        for (const row of rows) {
            const tag = toTagEntry(row);
            byNumber.set(tag.tagNumber, tag);
        }
    };
    addRows(
        `SELECT ${TAG_SELECT_COLUMNS} FROM tags
         WHERE session_id = ? AND status = 'active'
         ORDER BY tag_number DESC, id DESC LIMIT ?`,
        protectedTags,
    );
    addRows(
        `SELECT ${TAG_SELECT_COLUMNS} FROM tags
         WHERE session_id = ? AND type = 'tool'
         ORDER BY tag_number DESC, id DESC LIMIT ?`,
        recentToolWindow,
    );
    return [...byNumber.values()].sort((left, right) => left.tagNumber - right.tagNumber);
}

export function getTagsByNumbers(
    db: Database,
    sessionId: string,
    tagNumbers: readonly number[],
): TagEntry[] {
    if (tagNumbers.length === 0) return [];

    // Chunk target sets stay below SQLite's 999-parameter limit.
    if (tagNumbers.length > 900) {
        const all: TagEntry[] = [];
        for (let i = 0; i < tagNumbers.length; i += 900) {
            all.push(...getTagsByNumbers(db, sessionId, tagNumbers.slice(i, i + 900)));
        }
        return all;
    }

    const placeholders = tagNumbers.map(() => "?").join(",");
    const rows = db
        .prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND tag_number IN (${placeholders}) ORDER BY tag_number ASC, id ASC`,
        )
        .all(sessionId, ...tagNumbers)
        .filter(isTagRow);

    return rows.map(toTagEntry);
}

/* */
export function getDroppedTagsByNumbers(
    db: Database,
    sessionId: string,
    tagNumbers: readonly number[],
): TagEntry[] {
    if (tagNumbers.length === 0) return [];

    if (tagNumbers.length > 900) {
        const all: TagEntry[] = [];
        for (let i = 0; i < tagNumbers.length; i += 900) {
            all.push(...getDroppedTagsByNumbers(db, sessionId, tagNumbers.slice(i, i + 900)));
        }
        return all;
    }

    const placeholders = tagNumbers.map(() => "?").join(",");
    const rows = db
        .prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND status = 'dropped' AND tag_number IN (${placeholders}) ORDER BY tag_number ASC, id ASC`,
        )
        .all(sessionId, ...tagNumbers)
        .filter(isTagRow);

    return rows.map(toTagEntry);
}

/**
 *
 * SQL MAX avoids loading all dropped tags into memory.
 * The dropped-tag partial index can avoid scanning non-dropped rows.
 */
export function getMaxDroppedTagNumber(db: Database, sessionId: string): number {
    const row = getMaxDroppedTagNumberStatement(db).get(sessionId);
    return isMaxTagNumberRow(row) ? row.max_tag_number : 0;
}

export function getTagById(db: Database, sessionId: string, tagId: number): TagEntry | null {
    const result = db
        .prepare(`SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND tag_number = ?`)
        .get(sessionId, tagId);

    if (!isTagRow(result)) {
        return null;
    }

    return toTagEntry(result);
}

export function getTopNBySize(db: Database, sessionId: string, n: number): TagEntry[] {
    if (n <= 0) {
        return [];
    }

    const rows = db
        .prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND status = 'active' ORDER BY byte_size DESC, tag_number ASC LIMIT ?`,
        )
        .all(sessionId, n)
        .filter(isTagRow);

    return rows.map(toTagEntry);
}

//
// Tool tags require composite identity when call IDs can collide.
// The persistent identity is `(session_id, callID, tool_owner_message_id)`.
//
//

const getToolTagNumberByOwnerStatements = new WeakMap<Database, PreparedStatement>();
const getNullOwnerToolTagStatements = new WeakMap<Database, PreparedStatement>();
const adoptNullOwnerToolTagStatements = new WeakMap<Database, PreparedStatement>();
const deleteToolTagsByOwnerStatements = new WeakMap<Database, PreparedStatement>();

function getGetToolTagNumberByOwnerStatement(db: Database): PreparedStatement {
    let stmt = getToolTagNumberByOwnerStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT tag_number FROM tags
             WHERE session_id = ? AND message_id = ?
               AND type = 'tool' AND tool_owner_message_id = ?
             LIMIT 1`,
        );
        getToolTagNumberByOwnerStatements.set(db, stmt);
    }
    return stmt;
}

/**
 *
 * The runtime tagger uses this lookup after restart or cache eviction.
 */
export function getToolTagNumberByOwner(
    db: Database,
    sessionId: string,
    callId: string,
    ownerMsgId: string,
): number | null {
    const row = getGetToolTagNumberByOwnerStatement(db).get(sessionId, callId, ownerMsgId);
    return isTagNumberRow(row) ? row.tag_number : null;
}

interface NullOwnerToolTagRow {
    id: number;
    tag_number: number;
}

function isNullOwnerToolTagRow(row: unknown): row is NullOwnerToolTagRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.id === "number" && typeof r.tag_number === "number";
}

function getGetNullOwnerToolTagStatement(db: Database): PreparedStatement {
    let stmt = getNullOwnerToolTagStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT id, tag_number FROM tags
             WHERE session_id = ? AND message_id = ?
               AND type = 'tool' AND tool_owner_message_id IS NULL
             ORDER BY tag_number ASC
             LIMIT 1`,
        );
        getNullOwnerToolTagStatements.set(db, stmt);
    }
    return stmt;
}

/**
 *
 * Adopt a matching NULL-owner row to preserve its existing tag number.
 *
 * Treat a false result from `adoptNullOwnerToolTag` as a lost adoption race.
 */
export function getNullOwnerToolTag(
    db: Database,
    sessionId: string,
    callId: string,
): { id: number; tagNumber: number } | null {
    const row = getGetNullOwnerToolTagStatement(db).get(sessionId, callId);
    if (!isNullOwnerToolTagRow(row)) return null;
    return { id: row.id, tagNumber: row.tag_number };
}

function getAdoptNullOwnerToolTagStatement(db: Database): PreparedStatement {
    let stmt = adoptNullOwnerToolTagStatements.get(db);
    if (!stmt) {
        // Treat `changes = 0` as a lost adoption race.
        // recover.
        stmt = db.prepare(
            `UPDATE tags
             SET tool_owner_message_id = ?
             WHERE id = ? AND tool_owner_message_id IS NULL`,
        );
        adoptNullOwnerToolTagStatements.set(db, stmt);
    }
    return stmt;
}

/**
 *
 */
export function adoptNullOwnerToolTag(db: Database, rowId: number, ownerMsgId: string): boolean {
    const result = getAdoptNullOwnerToolTagStatement(db).run(ownerMsgId, rowId);
    return (result.changes ?? 0) === 1;
}

/**
 *
 *
 */
export function getCandidateToolOwners(db: Database, sessionId: string, callId: string): string[] {
    const rows = db
        .prepare(
            `SELECT DISTINCT tool_owner_message_id
             FROM tags
             WHERE session_id = ?
               AND message_id = ?
               AND type = 'tool'
               AND tool_owner_message_id IS NOT NULL`,
        )
        .all(sessionId, callId) as Array<{ tool_owner_message_id: string }>;
    return rows.map((r) => r.tool_owner_message_id);
}

/**
 *
 *
 */
export function pickNearestPriorOwner(
    candidates: readonly string[],
    currentMessageId: string,
    times: ReadonlyMap<string, number>,
): string | null {
    const currentTime = times.get(currentMessageId);
    if (typeof currentTime !== "number") return null;

    let best: { id: string; time: number } | null = null;
    for (const id of candidates) {
        const t = times.get(id);
        if (typeof t !== "number") continue;
        if (t > currentTime) continue;
        if (t === currentTime && id >= currentMessageId) continue;
        if (best === null || t > best.time || (t === best.time && id > best.id)) {
            best = { id, time: t };
        }
    }
    return best?.id ?? null;
}

/**
 * Callers needing owner selection must resolve message times before calling `pickNearestPriorOwner`.
 *
 */
export function getPersistedToolOwnerNearestPrior(
    _db: Database,
    _sessionId: string,
    _callId: string,
    _currentMessageId: string,
): string | null {
    return null;
}

function getDeleteToolTagsByOwnerStatement(db: Database): PreparedStatement {
    let stmt = deleteToolTagsByOwnerStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `DELETE FROM tags
             WHERE session_id = ?
               AND type = 'tool'
               AND tool_owner_message_id = ?`,
        );
        deleteToolTagsByOwnerStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * `NULL` `tool_owner_message_id` rows are not deleted.
 *
 */
export function deleteToolTagsByOwner(db: Database, sessionId: string, ownerMsgId: string): number {
    const result = getDeleteToolTagsByOwnerStatement(db).run(sessionId, ownerMsgId);
    return result.changes ?? 0;
}
