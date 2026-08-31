import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import {
    adoptNullOwnerToolTag,
    backfillTagTokenCounts,
    getMaxTagNumberBySession,
    getNullOwnerToolTag,
    getTagNumberByMessageId,
    getToolTagNumberByOwner,
    insertTag,
    type TagTokenCounts,
    tagTokenCountIsNull,
} from "./storage-tags";
import type { TagEntry } from "./types";

/**
 * NUL cannot occur in IDs, so the assignments map can concatenate ownerMsgId and callId unambiguously.
 *
 * Tool tags require ownerMsgId in addition to callId because callId can repeat across assistant turns.
 *
 * Message and file tags use bare messageId keys because their generated IDs are unique within a session.
 * Message and file IDs use `${msgId}:p${ord}` and `${msgId}:fileN` formats.
 */
const TOOL_COMPOSITE_KEY_SEP = "\x00";

export function makeToolCompositeKey(ownerMsgId: string, callId: string): string {
    return `${ownerMsgId}${TOOL_COMPOSITE_KEY_SEP}${callId}`;
}

/**
 * Tool paths must use `assignToolTag` or `getToolTag` so `ownerMsgId` participates in the composite key.
 *
 * The runtime guard rejects "tool" values introduced through as any casts.
 */
type NonToolTagType = Exclude<TagEntry["type"], "tool">;

export interface ToolTagAccounting {
    byteSize: number;
    tokenCount: number | null;
    inputByteSize: number;
    inputTokenCount: number | null;
}

export interface Tagger {
    /**
     *
     */
    assignTag(
        sessionId: string,
        messageId: string,
        type: NonToolTagType,
        byteSize: number,
        db: Database,
        reasoningByteSize?: number,
        toolName?: string | null,
        inputByteSize?: number,
        /**
         * Pi persists entryFingerprint so a later pass can rebind a fallback-ID tag to its SessionEntry ID.
         */
        entryFingerprint?: string | null,
        /**
         * The tagger invokes tokenThunk only when it inserts a new tag.
         */
        tokenThunk?: () => TagTokenCounts,
    ): number;
    /**
     *
     */
    getTag(sessionId: string, messageId: string, type: NonToolTagType): number | undefined;
    /**
     * Composite identity prevents tool calls with reused `callId` values from sharing a tag.
     * Tool-tag identity includes `sessionId`, `callId`, and `ownerMsgId`.
     * Separate tool invocations must not inherit another invocation's drop status.
     *
     * `ownerMsgId` identifies the assistant message that hosts the tool invocation.
     * Pi parallel tool calls without `part.id` use `contentId` as `ownerMsgId`.
     * For these calls, `ownerMsgId === callId`.
     * `ownerMsgId === callId` gives each of these tool-call parts a distinct composite key.
     */
    assignToolTag(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
        byteSize: number,
        db: Database,
        reasoningByteSize?: number,
        toolName?: string | null,
        inputByteSize?: number,
        /* */
        tokenThunk?: () => TagTokenCounts,
    ): number;
    /**
     * identity.
     */
    getToolTag(sessionId: string, callId: string, ownerMsgId: string): number | undefined;
    /** `initFromDb` loads persisted accounting in the same scan as tool-tag identities. */
    getToolTagAccounting(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
    ): ToolTagAccounting | undefined;
    /** `setToolTagAccounting` synchronizes the loaded accounting mirror after same-connection writes. */
    setToolTagAccounting(sessionId: string, tagNumber: number, accounting: ToolTagAccounting): void;
    bindTag(sessionId: string, messageId: string, tagNumber: number): void;
    /**
     * `unbindTag` removes the old key after `message_id` migrates from a `pi-msg-*` fallback to the real ID.
     * Removing the fallback key prevents two keys from aliasing one tag number.
     */
    unbindTag(sessionId: string, messageId: string): void;
    /**
     * `${ownerMsgId}\x00${callId}`.
     */
    bindToolTag(sessionId: string, callId: string, ownerMsgId: string, tagNumber: number): void;
    /**
     * `unbindToolTag` removes the synthetic `pi-msg-*` owner key when a tool tag moves to the real owner.
     * `unbindToolTag` also removes keys for duplicate real-owner rows that are folded away.
     */
    unbindToolTag(sessionId: string, ownerMsgId: string, callId: string): void;
    getAssignments(sessionId: string): ReadonlyMap<string, number>;
    resetCounter(sessionId: string, db: Database): void;
    getCounter(sessionId: string): number;
    initFromDb(sessionId: string, db: Database, floor?: number): void;
    cleanup(sessionId: string): void;
}

const GET_COUNTER_SQL = `SELECT counter FROM session_meta WHERE session_id = ?`;
// `getToolTag` adopts database rows whose tool owner is NULL on its next call.
const GET_ASSIGNMENTS_SQL =
    "SELECT message_id, tag_number, type, tool_owner_message_id, byte_size, token_count, input_byte_size, input_token_count FROM tags WHERE session_id = ? ORDER BY tag_number ASC";
// `tag_number` increases with message order, so tags below the first wire tag are outside the wire.
// Tags below the first wire tag are compacted history and are not in the wire.
// `floor = 0` uses the unscoped query and loads the full session.
const GET_ASSIGNMENTS_SCOPED_SQL =
    "SELECT message_id, tag_number, type, tool_owner_message_id, byte_size, token_count, input_byte_size, input_token_count FROM tags WHERE session_id = ? AND tag_number >= ? ORDER BY tag_number ASC";

/**
 * `dataVersion` detects changes committed by other connections.
 *
 * `PRAGMA main.data_version` bumps when another connection commits to the database.
 * `PRAGMA main.data_version` does not bump for writes on the current connection.
 * The tagger is the sole same-connection writer of the assignment mapping.
 * The tagger's same-connection mapping writes update `sessionAssignments` and `counters` in memory.
 * Non-mapping writes on the current connection do not force a full assignments scan on every transform pass.
 *
 */
const PROBE_DATA_VERSION_SQL = "PRAGMA main.data_version";

const probeDataVersionStatements = new WeakMap<Database, PreparedStatement>();

function getProbeDataVersionStatement(db: Database): PreparedStatement {
    let stmt = probeDataVersionStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(PROBE_DATA_VERSION_SQL);
        probeDataVersionStatements.set(db, stmt);
    }
    return stmt;
}

interface AssignmentRow {
    message_id: string;
    tag_number: number;
    type: TagEntry["type"];
    tool_owner_message_id: string | null;
    byte_size: number;
    token_count: number | null;
    input_byte_size: number;
    input_token_count: number | null;
}

/**
 * Per-session signature recorded at the last successful `initFromDb` reload.
 */
interface LoadSignature {
    db: Database;
    dataVersion: number;
    /**
     * The cache identity includes the live-wire load-scoping floor; changing the floor forces one reload.
     */
    floor: number;
}

function isAssignmentRow(row: unknown): row is AssignmentRow {
    if (row === null || typeof row !== "object") {
        return false;
    }

    const candidate = row as Record<string, unknown>;
    if (typeof candidate.message_id !== "string") return false;
    if (typeof candidate.tag_number !== "number") return false;
    if (candidate.type !== "message" && candidate.type !== "tool" && candidate.type !== "file")
        return false;
    if (
        candidate.tool_owner_message_id !== null &&
        typeof candidate.tool_owner_message_id !== "string"
    )
        return false;
    if (typeof candidate.byte_size !== "number") return false;
    if (candidate.token_count !== null && typeof candidate.token_count !== "number") return false;
    if (typeof candidate.input_byte_size !== "number") return false;
    if (candidate.input_token_count !== null && typeof candidate.input_token_count !== "number")
        return false;
    return true;
}

/**
 * On conflict, counter upserts keep `MAX(existing, new)` to prevent concurrent or stale writers from decreasing the counter.
 * `assignTag()` allocates from the database, so a stale in-memory counter cannot reissue a tag number claimed by another writer.
 *
 * Preserving `harness` makes a session's origin immutable.
 * A session's `harness` does not change for the row's lifetime.
 */
const UPSERT_COUNTER_SQL = `
  INSERT INTO session_meta (session_id, counter, harness)
  VALUES (?, ?, ?)
  ON CONFLICT(session_id) DO UPDATE SET counter = MAX(session_meta.counter, excluded.counter)
`;

const upsertCounterStatements = new WeakMap<Database, PreparedStatement>();

function getUpsertCounterStatement(db: Database): PreparedStatement {
    let stmt = upsertCounterStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(UPSERT_COUNTER_SQL);
        upsertCounterStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Reset the counter to 0; unlike the monotonic upsert, this operation can decrease it.
 * `/ctx-recomp` rolls the counter back to rebuild a session.
 * `harness` is included on first INSERT because a session's origin is immutable.
 * monotonic upsert.
 */
const RESET_COUNTER_SQL = `
  INSERT INTO session_meta (session_id, counter, harness)
  VALUES (?, 0, ?)
  ON CONFLICT(session_id) DO UPDATE SET counter = 0
`;

const resetCounterStatements = new WeakMap<Database, PreparedStatement>();

function getResetCounterStatement(db: Database): PreparedStatement {
    let stmt = resetCounterStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(RESET_COUNTER_SQL);
        resetCounterStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Limit retries after a `tag_number` INSERT collides with an existing row.
 * A collision with a different `message_id` means the counter trails the database maximum.
 * The cap prevents unbounded retries under pathological state divergence.
 */
const MAX_TAG_ALLOC_RETRIES = 5;

export function createTagger(): Tagger {
    const counters = new Map<string, number>();
    const assignments = new Map<string, Map<string, number>>();
    // Persisted tool accounting is loaded with assignments, avoiding a point query
    const toolAccountingBySession = new Map<string, Map<number, ToolTagAccounting>>();
    // Per-session load signatures track the DB state at the last successful initFromDb() reload.
    // Skip the full database scan only when this session has a signature, its recorded `db` is the current object, and `data_version` matches.
    // The signature is valid only when its recorded `db` object is the current object.
    // The signature is valid only when `data_version` matches; a different `Database` object requires a reload.
    // external commit (data_version bump) falls through to the full reload.
    // Same-connection tagger writes update this map directly.
    // Same-connection tagger writes do not invalidate the signature.
    //
    // No signature entry requires a full reload on the next `initFromDb()` call.
    // `resetCounter` removes the signature so the next `initFromDb()` call performs a full reload.
    const loadSignatures = new Map<string, LoadSignature>();

    function getSessionAssignments(sessionId: string): Map<string, number> {
        let map = assignments.get(sessionId);
        if (!map) {
            map = new Map();
            assignments.set(sessionId, map);
        }
        return map;
    }

    function getSessionToolAccounting(sessionId: string): Map<number, ToolTagAccounting> {
        let map = toolAccountingBySession.get(sessionId);
        if (!map) {
            map = new Map();
            toolAccountingBySession.set(sessionId, map);
        }
        return map;
    }

    function isUniqueConstraintError(error: unknown): boolean {
        return (
            error instanceof Error &&
            "code" in error &&
            (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
        );
    }

    /**
     * Persist at least `value` in memory and the database.
     * The MAX-based upsert prevents concurrent writers from decreasing the session counter.
     * The MAX-based upsert prevents concurrent writers from decreasing the session counter.
     * The MAX-based upsert prevents concurrent writers from decreasing the session counter.
     */
    function syncCounterAtLeast(sessionId: string, db: Database, value: number): void {
        if (value <= 0) return;
        const next = Math.max(counters.get(sessionId) ?? 0, value);
        counters.set(sessionId, next);
        getUpsertCounterStatement(db).run(sessionId, next, getHarness());
    }

    /**
     *
     * `mapKey` uses `messageId` for message and file tags and `<owner>\x00<callId>` for tool tags.
     * `toolOwnerMessageId` is null for non-tool tags and non-null for tool tags.
     * `dbExistingLookup` returns the persisted tag number for the entity, or null when no tag exists.
     */
    function allocateTag(
        sessionId: string,
        messageId: string,
        type: TagEntry["type"],
        byteSize: number,
        db: Database,
        reasoningByteSize: number,
        toolName: string | null,
        inputByteSize: number,
        toolOwnerMessageId: string | null,
        mapKey: string,
        dbExistingLookup: () => number | null,
        entryFingerprint: string | null = null,
        tokenThunk?: () => TagTokenCounts,
    ): number {
        const sessionAssignments = getSessionAssignments(sessionId);

        const existing = sessionAssignments.get(mapKey);
        if (existing !== undefined) {
            return existing;
        }

        // Cleanup or restart can clear the in-memory map without changing persisted tag assignments.
        // The database lookup preserves the persisted assignment when cleanup or restart clears the in-memory map.
        // the row.
        const dbExisting = dbExistingLookup();
        if (dbExisting !== null) {
            sessionAssignments.set(mapKey, dbExisting);
            syncCounterAtLeast(sessionId, db, dbExisting);
            // A populated `token_count` never invokes `tokenThunk` again.
            if (tokenThunk && tagTokenCountIsNull(db, sessionId, dbExisting)) {
                try {
                    backfillTagTokenCounts(db, sessionId, dbExisting, tokenThunk());
                } catch {
                    // A transient SQLITE_BUSY leaves token_count NULL so a later read can retry the backfill.
                }
            }
            return dbExisting;
        }

        // New tags invoke `tokenThunk` at most once.
        const tokenCounts = tokenThunk?.() ?? null;

        for (let attempt = 0; attempt < MAX_TAG_ALLOC_RETRIES; attempt += 1) {
            const memCounter = counters.get(sessionId) ?? 0;
            const dbMax = getMaxTagNumberBySession(db, sessionId);
            const next = Math.max(memCounter, dbMax) + 1;

            try {
                db.transaction(() => {
                    insertTag(
                        db,
                        sessionId,
                        messageId,
                        type,
                        byteSize,
                        next,
                        reasoningByteSize,
                        toolName,
                        inputByteSize,
                        toolOwnerMessageId,
                        entryFingerprint,
                        tokenCounts,
                    );
                    getUpsertCounterStatement(db).run(sessionId, next, getHarness());
                })();
            } catch (error: unknown) {
                if (!isUniqueConstraintError(error)) {
                    throw error;
                }

                // `insertTag` can collide when another writer claims `next` or inserts this entity; retry the former and return the latter's tag.
                const racedRow = dbExistingLookup();
                if (racedRow !== null) {
                    sessionAssignments.set(mapKey, racedRow);
                    syncCounterAtLeast(sessionId, db, racedRow);
                    return racedRow;
                }

                const advancedDbMax = getMaxTagNumberBySession(db, sessionId);
                counters.set(sessionId, Math.max(memCounter, advancedDbMax));
                continue;
            }

            counters.set(sessionId, next);
            sessionAssignments.set(mapKey, next);
            if (type === "tool") {
                getSessionToolAccounting(sessionId).set(next, {
                    byteSize,
                    tokenCount: tokenCounts?.tokenCount ?? null,
                    inputByteSize,
                    inputTokenCount: tokenCounts?.inputTokenCount ?? null,
                });
            }
            return next;
        }

        throw new Error(
            `tagger.allocateTag: failed to allocate tag for session=${sessionId} key=${mapKey} after ${MAX_TAG_ALLOC_RETRIES} retries`,
        );
    }

    function assignTag(
        sessionId: string,
        messageId: string,
        type: NonToolTagType,
        byteSize: number,
        db: Database,
        reasoningByteSize: number = 0,
        toolName: string | null = null,
        inputByteSize: number = 0,
        entryFingerprint: string | null = null,
        tokenThunk?: () => TagTokenCounts,
    ): number {
        // Reject a runtime `"tool"` value passed through an unsafe cast.
        if ((type as string) === "tool") {
            throw new Error(
                "tagger.assignTag: type='tool' is forbidden — use assignToolTag(sessionId, callId, ownerMsgId, ...)",
            );
        }
        return allocateTag(
            sessionId,
            messageId,
            type,
            byteSize,
            db,
            reasoningByteSize,
            toolName,
            inputByteSize,
            null,
            messageId,
            () => getTagNumberByMessageId(db, sessionId, messageId),
            entryFingerprint,
            tokenThunk,
        );
    }

    /**
     * Tool fast paths backfill NULL `token_count` values because they return before `allocateTag`'s backfill.
     */
    function backfillToolTokensIfNull(
        db: Database,
        sessionId: string,
        tagNumber: number,
        tokenThunk?: () => TagTokenCounts,
    ): void {
        if (!tokenThunk) return;
        try {
            if (tagTokenCountIsNull(db, sessionId, tagNumber)) {
                backfillTagTokenCounts(db, sessionId, tagNumber, tokenThunk());
            }
        } catch {}
    }

    function assignToolTag(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
        byteSize: number,
        db: Database,
        reasoningByteSize: number = 0,
        toolName: string | null = null,
        inputByteSize: number = 0,
        tokenThunk?: () => TagTokenCounts,
    ): number {
        const compositeKey = makeToolCompositeKey(ownerMsgId, callId);
        const sessionAssignments = getSessionAssignments(sessionId);

        const existing = sessionAssignments.get(compositeKey);
        if (existing !== undefined) {
            return existing;
        }

        // An existing `(callId, ownerMsgId)` row supplies the tag to bind and return.
        const dbHit = getToolTagNumberByOwner(db, sessionId, callId, ownerMsgId);
        if (dbHit !== null) {
            sessionAssignments.set(compositeKey, dbHit);
            syncCounterAtLeast(sessionId, db, dbHit);
            backfillToolTokensIfNull(db, sessionId, dbHit, tokenThunk);
            return dbHit;
        }

        // A NULL-owner row can be atomically claimed.
        //
        // If a backfill writes an owner between the SELECT and NULL-guarded UPDATE, re-check the composite fast path; on a miss, try the next NULL-owner row.
        // On a composite-lookup miss, try the next NULL-owner row for the same `callId`.
        for (let attempt = 0; attempt < MAX_TAG_ALLOC_RETRIES; attempt += 1) {
            const orphan = getNullOwnerToolTag(db, sessionId, callId);
            if (orphan === null) break;

            const claimed = adoptNullOwnerToolTag(db, orphan.id, ownerMsgId);
            if (claimed) {
                sessionAssignments.set(compositeKey, orphan.tagNumber);
                syncCounterAtLeast(sessionId, db, orphan.tagNumber);
                backfillToolTokensIfNull(db, sessionId, orphan.tagNumber, tokenThunk);
                return orphan.tagNumber;
            }

            // After losing the claim race, re-check the composite fast path before allocating a new tag.
            const recheck = getToolTagNumberByOwner(db, sessionId, callId, ownerMsgId);
            if (recheck !== null) {
                sessionAssignments.set(compositeKey, recheck);
                syncCounterAtLeast(sessionId, db, recheck);
                backfillToolTokensIfNull(db, sessionId, recheck, tokenThunk);
                return recheck;
            }
            // `backfill` adopts only the lowest-`tag_number` NULL-owner row for each `callId`; later rows remain available for this claim.
        }

        // Fresh allocation
        return allocateTag(
            sessionId,
            callId,
            "tool",
            byteSize,
            db,
            reasoningByteSize,
            toolName,
            inputByteSize,
            ownerMsgId,
            compositeKey,
            () => getToolTagNumberByOwner(db, sessionId, callId, ownerMsgId),
            null,
            tokenThunk,
        );
    }

    function getTag(
        sessionId: string,
        messageId: string,
        _type: NonToolTagType,
    ): number | undefined {
        // `_type` exists only to enforce the non-tool contract at compile time.
        return assignments.get(sessionId)?.get(messageId);
    }

    function getToolTag(sessionId: string, callId: string, ownerMsgId: string): number | undefined {
        return assignments.get(sessionId)?.get(makeToolCompositeKey(ownerMsgId, callId));
    }

    function getToolTagAccounting(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
    ): ToolTagAccounting | undefined {
        const tagNumber = getToolTag(sessionId, callId, ownerMsgId);
        return tagNumber === undefined
            ? undefined
            : toolAccountingBySession.get(sessionId)?.get(tagNumber);
    }

    function setToolTagAccounting(
        sessionId: string,
        tagNumber: number,
        accounting: ToolTagAccounting,
    ): void {
        getSessionToolAccounting(sessionId).set(tagNumber, accounting);
    }

    function bindTag(sessionId: string, messageId: string, tagNumber: number): void {
        getSessionAssignments(sessionId).set(messageId, tagNumber);
    }

    function unbindTag(sessionId: string, messageId: string): void {
        getSessionAssignments(sessionId).delete(messageId);
    }

    function bindToolTag(
        sessionId: string,
        callId: string,
        ownerMsgId: string,
        tagNumber: number,
    ): void {
        getSessionAssignments(sessionId).set(makeToolCompositeKey(ownerMsgId, callId), tagNumber);
    }

    function unbindToolTag(sessionId: string, ownerMsgId: string, callId: string): void {
        getSessionAssignments(sessionId).delete(makeToolCompositeKey(ownerMsgId, callId));
    }

    function getAssignments(sessionId: string): ReadonlyMap<string, number> {
        return getSessionAssignments(sessionId);
    }

    function resetCounter(sessionId: string, db: Database): void {
        // Force-reset uses a non-monotonic UPDATE so callers can rebuild a session from scratch.
        // Force-reset uses a dedicated statement to bypass the monotonic upsert.
        counters.set(sessionId, 0);
        assignments.delete(sessionId);
        toolAccountingBySession.delete(sessionId);
        // Clearing the load signature forces the next `initFromDb` to reload.
        loadSignatures.delete(sessionId);
        getResetCounterStatement(db).run(sessionId, getHarness());
    }

    function getCounter(sessionId: string): number {
        return counters.get(sessionId) ?? 0;
    }

    /**
     */
    function probeSignature(db: Database): { dataVersion: number } {
        const dvRow = getProbeDataVersionStatement(db).get() as
            | { data_version: number }
            | null
            | undefined;
        return {
            dataVersion: dvRow?.data_version ?? 0,
        };
    }

    /**
     *
     * The cache hit requires the same `Database` object and an unchanged `data_version` since the last successful full reload.
     *
     * Same-connection mapping writes do not invalidate this cache because they update `sessionAssignments` in memory; allocation also updates `counters`.
     * `assignToolTag`, fallback adoption, and bind/unbind paths keep `sessionAssignments` synchronized with mapping changes.
     * Non-mapping same-connection writes to byte/token counts, source content, or pending ops do not affect this loader.
     *
     * Taking the maximum prevents `assignTag` from reusing an existing tag number.
     *
     * `initFromDb` updates the cached signature only after all reload queries succeed.
     * in-memory state.
     */
    function initFromDb(sessionId: string, db: Database, floor = 0): void {
        const probe = probeSignature(db);
        const cached = loadSignatures.get(sessionId);
        if (
            cached !== undefined &&
            cached.db === db &&
            cached.dataVersion === probe.dataVersion &&
            cached.floor === floor
        ) {
            return;
        }

        const row = db.prepare(GET_COUNTER_SQL).get(sessionId) as
            | { counter: number }
            | null
            | undefined;
        const assignmentRows = (
            floor > 0
                ? db.prepare(GET_ASSIGNMENTS_SCOPED_SQL).all(sessionId, floor)
                : db.prepare(GET_ASSIGNMENTS_SQL).all(sessionId)
        ).filter(isAssignmentRow);
        const sessionAssignments = getSessionAssignments(sessionId);
        sessionAssignments.clear();
        const sessionToolAccounting = getSessionToolAccounting(sessionId);
        sessionToolAccounting.clear();

        let maxTagNumber = 0;
        for (const assignment of assignmentRows) {
            if (assignment.type === "tool") {
                if (assignment.tool_owner_message_id !== null) {
                    sessionAssignments.set(
                        makeToolCompositeKey(
                            assignment.tool_owner_message_id,
                            assignment.message_id,
                        ),
                        assignment.tag_number,
                    );
                    sessionToolAccounting.set(assignment.tag_number, {
                        byteSize: assignment.byte_size,
                        tokenCount: assignment.token_count,
                        inputByteSize: assignment.input_byte_size,
                        inputTokenCount: assignment.input_token_count,
                    });
                }
            } else {
                sessionAssignments.set(assignment.message_id, assignment.tag_number);
            }
            if (assignment.tag_number > maxTagNumber) {
                maxTagNumber = assignment.tag_number;
            }
        }

        // Taking the maximum avoids reusing tag numbers already visible in the persisted counter, assignments table, or in-memory counter.
        const counter = Math.max(row?.counter ?? 0, maxTagNumber, counters.get(sessionId) ?? 0);
        counters.set(sessionId, counter);

        loadSignatures.set(sessionId, {
            db,
            dataVersion: probe.dataVersion,
            floor,
        });
    }

    function cleanup(sessionId: string): void {
        counters.delete(sessionId);
        assignments.delete(sessionId);
        toolAccountingBySession.delete(sessionId);
        loadSignatures.delete(sessionId);
    }

    return {
        assignTag,
        assignToolTag,
        getTag,
        getToolTag,
        getToolTagAccounting,
        setToolTagAccounting,
        bindTag,
        unbindTag,
        bindToolTag,
        unbindToolTag,
        getAssignments,
        resetCounter,
        getCounter,
        initFromDb,
        cleanup,
    };
}
