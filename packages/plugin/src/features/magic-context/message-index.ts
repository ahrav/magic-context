import { createHash } from "node:crypto";
import {
    cleanUserText,
    extractTexts,
    hasMeaningfulUserText,
} from "../../hooks/magic-context/read-session-chunk";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { removeSystemReminders } from "../../shared/system-directive";
import { clearCompressionDepth } from "./compression-depth-storage";

interface MessageHistoryIndexRow {
    last_indexed_ordinal?: number;
    dirty_floor_ordinal?: number;
}

interface MessageHistorySourceRow {
    message_ordinal?: number;
    source_version?: string;
    normalized_content_hash?: string;
    role?: string;
}

interface MessageHistoryOrphanSweepRow {
    cursor_session_id?: string;
    last_swept_at?: number | null;
}

export interface MessageHistoryOrphanSweepResult {
    status: "swept" | "cooldown" | "source_unavailable";
    scanned: number;
    deleted: number;
    cursor: string;
}

export interface MessageHistoryOrphanSweepOptions {
    batchSize?: number;
    now?: number;
    safetyAgeMs?: number;
    cooldownMs?: number;
    unavailableReprobeMs?: number;
}

export const MESSAGE_HISTORY_ORPHAN_SWEEP_BATCH_SIZE = 200;
export const MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS = 24 * 60 * 60 * 1000;
export const MESSAGE_HISTORY_ORPHAN_SWEEP_COOLDOWN_MS = 10 * 60 * 1000;
export const MESSAGE_HISTORY_ORPHAN_UNAVAILABLE_REPROBE_MS = 24 * 60 * 60 * 1000;

const lastIndexedStatements = new WeakMap<Database, PreparedStatement>();
const insertMessageStatements = new WeakMap<Database, PreparedStatement>();
const upsertProgressStatements = new WeakMap<Database, PreparedStatement>();
const upsertDirtyFloorStatements = new WeakMap<Database, PreparedStatement>();
const deleteFtsStatements = new WeakMap<Database, PreparedStatement>();
const deleteFtsRangeStatements = new WeakMap<Database, PreparedStatement>();
const deleteIndexStatements = new WeakMap<Database, PreparedStatement>();
const countIndexedMessageStatements = new WeakMap<Database, PreparedStatement>();
const getMessageSourceStatements = new WeakMap<Database, PreparedStatement>();
const upsertMessageSourceStatements = new WeakMap<Database, PreparedStatement>();
const deleteMessageSourceStatements = new WeakMap<Database, PreparedStatement>();
const deleteMessageSourceRangeStatements = new WeakMap<Database, PreparedStatement>();
const deleteMessageFtsStatements = new WeakMap<Database, PreparedStatement>();

function normalizeIndexText(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function getLastIndexedStatement(db: Database): PreparedStatement {
    let stmt = lastIndexedStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT last_indexed_ordinal, dirty_floor_ordinal FROM message_history_index WHERE session_id = ?",
        );
        lastIndexedStatements.set(db, stmt);
    }
    return stmt;
}

function getInsertMessageStatement(db: Database): PreparedStatement {
    let stmt = insertMessageStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
        );
        insertMessageStatements.set(db, stmt);
    }
    return stmt;
}

function getUpsertProgressStatement(db: Database): PreparedStatement {
    let stmt = upsertProgressStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO message_history_index (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_indexed_ordinal = excluded.last_indexed_ordinal, dirty_floor_ordinal = excluded.dirty_floor_ordinal, updated_at = excluded.updated_at",
        );
        upsertProgressStatements.set(db, stmt);
    }
    return stmt;
}

function getUpsertDirtyFloorStatement(db: Database): PreparedStatement {
    let stmt = upsertDirtyFloorStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO message_history_index (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET last_indexed_ordinal = MAX(message_history_index.last_indexed_ordinal, excluded.last_indexed_ordinal), dirty_floor_ordinal = CASE WHEN message_history_index.dirty_floor_ordinal <= 0 THEN excluded.dirty_floor_ordinal WHEN excluded.dirty_floor_ordinal <= 0 THEN message_history_index.dirty_floor_ordinal ELSE MIN(message_history_index.dirty_floor_ordinal, excluded.dirty_floor_ordinal) END, updated_at = excluded.updated_at",
        );
        upsertDirtyFloorStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteFtsStatement(db: Database): PreparedStatement {
    let stmt = deleteFtsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM message_history_fts WHERE session_id = ?");
        deleteFtsStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteFtsRangeStatement(db: Database): PreparedStatement {
    let stmt = deleteFtsRangeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "DELETE FROM message_history_fts WHERE session_id = ? AND CAST(message_ordinal AS INTEGER) BETWEEN ? AND ?",
        );
        deleteFtsRangeStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteIndexStatement(db: Database): PreparedStatement {
    let stmt = deleteIndexStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM message_history_index WHERE session_id = ?");
        deleteIndexStatements.set(db, stmt);
    }
    return stmt;
}

function getCountIndexedMessageStatement(db: Database): PreparedStatement {
    let stmt = countIndexedMessageStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ? AND message_id = ?",
        );
        countIndexedMessageStatements.set(db, stmt);
    }
    return stmt;
}

function getMessageSourceStatement(db: Database): PreparedStatement {
    let stmt = getMessageSourceStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT message_ordinal, source_version, normalized_content_hash, role FROM message_history_source WHERE session_id = ? AND message_id = ?",
        );
        getMessageSourceStatements.set(db, stmt);
    }
    return stmt;
}

function getUpsertMessageSourceStatement(db: Database): PreparedStatement {
    let stmt = upsertMessageSourceStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `INSERT INTO message_history_source (
                 session_id, message_id, message_ordinal, source_version,
                 normalized_content_hash, role, harness, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, message_id) DO UPDATE SET
                 message_ordinal = excluded.message_ordinal,
                 source_version = excluded.source_version,
                 normalized_content_hash = excluded.normalized_content_hash,
                 role = excluded.role,
                 harness = excluded.harness,
                 updated_at = excluded.updated_at`,
        );
        upsertMessageSourceStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteMessageSourceStatement(db: Database): PreparedStatement {
    let stmt = deleteMessageSourceStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM message_history_source WHERE session_id = ?");
        deleteMessageSourceStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteMessageSourceRangeStatement(db: Database): PreparedStatement {
    let stmt = deleteMessageSourceRangeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "DELETE FROM message_history_source WHERE session_id = ? AND message_ordinal BETWEEN ? AND ?",
        );
        deleteMessageSourceRangeStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteMessageFtsStatement(db: Database): PreparedStatement {
    let stmt = deleteMessageFtsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "DELETE FROM message_history_fts WHERE session_id = ? AND message_id = ?",
        );
        deleteMessageFtsStatements.set(db, stmt);
    }
    return stmt;
}

interface CountRow {
    count: number;
}

function normalizeSourceVersion(version: RawMessage["version"]): string {
    if (typeof version === "number") return `number:${version}`;
    if (typeof version === "string") return `string:${version}`;
    return "null";
}

function getMessageSourceSnapshot(message: RawMessage): {
    ordinal: number;
    sourceVersion: string;
    contentHash: string;
    role: string;
    content: string;
} {
    const content = getIndexableContent(message.role, message.parts);
    return {
        ordinal: message.ordinal,
        sourceVersion: normalizeSourceVersion(message.version),
        contentHash: createHash("sha256").update(content).digest("hex"),
        role: message.role,
        content,
    };
}

export function getMessageIndexSourceIdentity(message: RawMessage): string {
    const source = getMessageSourceSnapshot(message);
    return JSON.stringify([source.ordinal, source.sourceVersion, source.contentHash, source.role]);
}

export function isMessageIndexSourceCurrent(
    db: Database,
    sessionId: string,
    message: RawMessage,
): boolean {
    const source = getMessageSourceSnapshot(message);
    const row = getMessageSourceStatement(db).get(
        sessionId,
        message.id,
    ) as MessageHistorySourceRow | null;
    return (
        row?.message_ordinal === source.ordinal &&
        row.source_version === source.sourceVersion &&
        row.normalized_content_hash === source.contentHash &&
        row.role === source.role
    );
}

function setMessageSource(
    db: Database,
    sessionId: string,
    message: RawMessage,
    now: number,
): string {
    const source = getMessageSourceSnapshot(message);
    getUpsertMessageSourceStatement(db).run(
        sessionId,
        message.id,
        source.ordinal,
        source.sourceVersion,
        source.contentHash,
        source.role,
        getHarness(),
        now,
    );
    return source.content;
}

export function getLastIndexedOrdinal(db: Database, sessionId: string): number {
    const row = getLastIndexedStatement(db).get(sessionId) as MessageHistoryIndexRow | null;
    return typeof row?.last_indexed_ordinal === "number" ? row.last_indexed_ordinal : 0;
}

/**
 * The index watermark provides an IDF-lite denominator.
 * Message ordinals are contiguous through the watermark.
 * Non-indexable rows may make the denominator approximate, avoiding a global FTS scan.
 */
export function getIndexedMessageCorpusSize(
    db: Database,
    sessionId: string,
    maxOrdinal: number | null,
): number {
    const watermark = getLastIndexedOrdinal(db, sessionId);
    return maxOrdinal === null ? watermark : Math.min(watermark, Math.max(0, maxOrdinal));
}

export function getDirtyIndexFloor(db: Database, sessionId: string): number | null {
    const row = getLastIndexedStatement(db).get(sessionId) as MessageHistoryIndexRow | null;
    return typeof row?.dirty_floor_ordinal === "number" && row.dirty_floor_ordinal > 0
        ? row.dirty_floor_ordinal
        : null;
}

/**
 * markMessageIndexDirty records the earliest ordinal an incremental write could leave missing.
 * Callers set the dirty floor before the FTS transaction so crashes and write failures leave durable reconciliation state.
 * The dirty floor prevents a crash or write failure from leaving an uncovered watermark.
 */
export function markMessageIndexDirty(db: Database, sessionId: string, floorOrdinal: number): void {
    const dirtyFloor = Math.max(1, Math.floor(floorOrdinal));
    getUpsertDirtyFloorStatement(db).run(
        sessionId,
        getLastIndexedOrdinal(db, sessionId),
        dirtyFloor,
        Date.now(),
        getHarness(),
    );
}

function isMessageAlreadyIndexed(db: Database, sessionId: string, messageId: string): boolean {
    const row = getCountIndexedMessageStatement(db).get(sessionId, messageId) as CountRow | null;
    return (typeof row?.count === "number" ? row.count : 0) > 0;
}

function setIndexProgress(
    db: Database,
    sessionId: string,
    watermark: number,
    dirtyFloor: number | null,
    now: number,
): void {
    getUpsertProgressStatement(db).run(
        sessionId,
        Math.max(0, Math.floor(watermark)),
        dirtyFloor ?? 0,
        now,
        getHarness(),
    );
}

export function getMessageIndexReconciliationStartOrdinal(db: Database, sessionId: string): number {
    const watermark = getLastIndexedOrdinal(db, sessionId);
    const dirtyFloor = getDirtyIndexFloor(db, sessionId);
    return dirtyFloor === null ? watermark : Math.min(watermark, dirtyFloor - 1);
}

export function isMessageIndexReconciledThrough(
    db: Database,
    sessionId: string,
    finalWatermark: number,
): boolean {
    const dirtyFloor = getDirtyIndexFloor(db, sessionId);
    return getLastIndexedOrdinal(db, sessionId) >= finalWatermark && dirtyFloor === null;
}

export function deleteIndexedMessage(db: Database, sessionId: string, messageId: string): number {
    const row = getCountIndexedMessageStatement(db).get(sessionId, messageId) as CountRow | null;
    const count = typeof row?.count === "number" ? row.count : 0;

    // Deleting a message requires a full reindex on the next search because ordinals are positional rather than stable IDs.
    // Removing a message shifts all subsequent ordinals; a stale tracker could make ensureMessagesIndexed() skip newly added messages when counts match.
    // Clearing both FTS rows and the tracker forces a complete rebuild on next search.
    clearIndexedMessages(db, sessionId);
    return count;
}

export function clearIndexedMessages(db: Database, sessionId: string): void {
    db.transaction(() => {
        getDeleteFtsStatement(db).run(sessionId);
        getDeleteMessageSourceStatement(db).run(sessionId);
        getDeleteIndexStatement(db).run(sessionId);
        clearCompressionDepth(db, sessionId);
    })();
}

export function getIndexableContent(role: string, parts: unknown[]): string {
    if (role === "user") {
        if (!hasMeaningfulUserText(parts)) {
            return "";
        }

        return extractTexts(parts)
            .map(cleanUserText)
            .map(normalizeIndexText)
            .filter((text) => text.length > 0)
            .join(" / ");
    }

    if (role === "assistant") {
        return extractTexts(parts)
            .map(removeSystemReminders)
            .map(normalizeIndexText)
            .filter((text) => text.length > 0)
            .join(" / ");
    }

    return "";
}

function indexSingleMessageInTransaction(
    db: Database,
    sessionId: string,
    message: RawMessage,
    now: number,
    dirtyFloorBeforeAttempt: number | null,
): boolean {
    const currentWatermark = getLastIndexedOrdinal(db, sessionId);
    const dirtyFloor = getDirtyIndexFloor(db, sessionId);

    if (message.ordinal <= currentWatermark) {
        if (isMessageIndexSourceCurrent(db, sessionId, message)) {
            return false;
        }

        // A covered ordinal represents a same-ID edit or redaction; the indexer replaces only that ordinal's FTS document.
        // The indexer replaces the covered ordinal's FTS document without moving the watermark.
        getDeleteMessageFtsStatement(db).run(sessionId, message.id);
        const content = setMessageSource(db, sessionId, message, now);
        if (content.length > 0 && (message.role === "user" || message.role === "assistant")) {
            getInsertMessageStatement(db).run(
                sessionId,
                message.ordinal,
                message.id,
                message.role,
                content,
            );
        }
        setIndexProgress(
            db,
            sessionId,
            currentWatermark,
            dirtyFloorBeforeAttempt === message.ordinal ? null : dirtyFloorBeforeAttempt,
            now,
        );
        return true;
    }

    // A live event may only extend the already-covered prefix by one ordinal.
    // Out-of-order events record their earliest missing ordinal as dirty for the paged reconciler rather than advancing the watermark across a hole.
    if (
        message.ordinal !== currentWatermark + 1 ||
        (dirtyFloor !== null && dirtyFloor !== message.ordinal)
    ) {
        return false;
    }

    const content = setMessageSource(db, sessionId, message, now);
    let inserted = false;
    if (
        content.length > 0 &&
        (message.role === "user" || message.role === "assistant") &&
        !isMessageAlreadyIndexed(db, sessionId, message.id)
    ) {
        getInsertMessageStatement(db).run(
            sessionId,
            message.ordinal,
            message.id,
            message.role,
            content,
        );
        inserted = true;
    }

    setIndexProgress(
        db,
        sessionId,
        message.ordinal,
        dirtyFloorBeforeAttempt === message.ordinal ? null : dirtyFloorBeforeAttempt,
        now,
    );
    return inserted;
}

export function indexSingleMessage(db: Database, sessionId: string, message: RawMessage): boolean {
    const currentWatermark = getLastIndexedOrdinal(db, sessionId);
    if (
        message.ordinal <= currentWatermark &&
        isMessageIndexSourceCurrent(db, sessionId, message)
    ) {
        return false;
    }
    const dirtyFloorBeforeAttempt = getDirtyIndexFloor(db, sessionId);

    // The indexer persists the reconciliation floor before the replacement transaction so failed DELETE, INSERT, or COMMIT operations trigger reconstruction from the authoritative source.
    markMessageIndexDirty(db, sessionId, Math.min(message.ordinal, currentWatermark + 1));

    // BEGIN IMMEDIATE serializes terminal updates because message_history_fts has no UNIQUE constraint and deduplication occurs inside the transaction.
    // Taking the writer lock up front serializes concurrent terminal updates so the second transaction sees the first transaction's source state.
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
        const result = indexSingleMessageInTransaction(
            db,
            sessionId,
            message,
            Date.now(),
            dirtyFloorBeforeAttempt,
        );
        db.exec("COMMIT");
        committed = true;
        return result;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {}
        }
    }
}

export function indexMessagesAfterOrdinal(
    db: Database,
    sessionId: string,
    messages: RawMessage[],
    _lastIndexedOrdinal: number,
    finalWatermark: number = messages.length,
): number {
    const now = Date.now();
    let inserted = 0;

    // The writer lock protects both duplicate checks and the progress row.
    // Each caller supplies one bounded source page, so the lock is held for that page rather than the full session history.
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
        const currentWatermark = getLastIndexedOrdinal(db, sessionId);
        const dirtyFloor = getDirtyIndexFloor(db, sessionId);
        const effectiveWatermark =
            dirtyFloor === null
                ? currentWatermark
                : Math.min(currentWatermark, Math.max(0, dirtyFloor - 1));

        if (dirtyFloor !== null && dirtyFloor <= finalWatermark) {
            // The rebuild affects only rows represented by this source snapshot.
            // The rebuild must not delete live rows newer than the source snapshot.
            getDeleteFtsRangeStatement(db).run(sessionId, dirtyFloor, finalWatermark);
            getDeleteMessageSourceRangeStatement(db).run(sessionId, dirtyFloor, finalWatermark);
        }

        const messagesByOrdinal = new Map<number, RawMessage>();
        for (const message of messages) {
            if (message.ordinal > effectiveWatermark && message.ordinal <= finalWatermark) {
                messagesByOrdinal.set(message.ordinal, message);
            }
        }

        let coveredWatermark = effectiveWatermark;
        while (coveredWatermark < finalWatermark && messagesByOrdinal.has(coveredWatermark + 1)) {
            coveredWatermark += 1;
        }

        for (let ordinal = effectiveWatermark + 1; ordinal <= coveredWatermark; ordinal++) {
            const message = messagesByOrdinal.get(ordinal);
            if (!message) continue;

            const content = setMessageSource(db, sessionId, message, now);
            if (
                content.length === 0 ||
                (message.role !== "user" && message.role !== "assistant") ||
                isMessageAlreadyIndexed(db, sessionId, message.id)
            ) {
                continue;
            }
            getInsertMessageStatement(db).run(
                sessionId,
                message.ordinal,
                message.id,
                message.role,
                content,
            );
            inserted += 1;
        }

        const missingFloor = coveredWatermark < finalWatermark ? coveredWatermark + 1 : null;
        const preservedFloor =
            dirtyFloor !== null && dirtyFloor > finalWatermark ? dirtyFloor : null;
        const nextDirtyFloor =
            missingFloor === null
                ? preservedFloor
                : preservedFloor === null
                  ? missingFloor
                  : Math.min(missingFloor, preservedFloor);

        // The FTS watermark advances only across contiguous source ordinals.
        // dirty floor remains recorded until a source page actually covers it.
        setIndexProgress(db, sessionId, coveredWatermark, nextDirtyFloor, now);
        db.exec("COMMIT");
        committed = true;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {}
        }
    }
    return inserted;
}

export function ensureMessagesIndexed(
    db: Database,
    sessionId: string,
    readMessages: (sessionId: string) => RawMessage[],
): void {
    const messages = readMessages(sessionId);

    if (messages.length === 0) {
        db.transaction(() => clearIndexedMessages(db, sessionId))();
        return;
    }

    let lastIndexedOrdinal = getLastIndexedOrdinal(db, sessionId);
    if (lastIndexedOrdinal > messages.length) {
        db.transaction(() => clearIndexedMessages(db, sessionId))();
        lastIndexedOrdinal = 0;
    }

    if (lastIndexedOrdinal >= messages.length && getDirtyIndexFloor(db, sessionId) === null) {
        return;
    }

    indexMessagesAfterOrdinal(db, sessionId, messages, lastIndexedOrdinal, messages.length);
}

function getMessageHistoryOrphanSweepState(db: Database): MessageHistoryOrphanSweepRow {
    return (
        (db
            .prepare(
                "SELECT cursor_session_id, last_swept_at FROM message_history_orphan_sweep WHERE harness = 'opencode'",
            )
            .get() as MessageHistoryOrphanSweepRow | null) ?? {}
    );
}

function persistMessageHistoryOrphanSweepState(
    db: Database,
    cursor: string,
    lastSweptAt: number | null,
): void {
    db.prepare(
        `INSERT INTO message_history_orphan_sweep (harness, cursor_session_id, last_swept_at)
         VALUES ('opencode', ?, ?)
         ON CONFLICT(harness) DO UPDATE SET
             cursor_session_id = excluded.cursor_session_id,
             last_swept_at = excluded.last_swept_at`,
    ).run(cursor, lastSweptAt);
}

/**
 * The cleanup cursor survives restarts and resets only after a complete pass.
 */
export function sweepOrphanedOpenCodeMessageIndexes(
    db: Database,
    openReadableOpenCodeDb: () => Database | null,
    options: MessageHistoryOrphanSweepOptions = {},
): MessageHistoryOrphanSweepResult {
    const now = options.now ?? Date.now();
    const batchSize = Math.max(
        1,
        Math.floor(options.batchSize ?? MESSAGE_HISTORY_ORPHAN_SWEEP_BATCH_SIZE),
    );
    const safetyAgeMs = Math.max(0, options.safetyAgeMs ?? MESSAGE_HISTORY_ORPHAN_SAFETY_AGE_MS);
    const cooldownMs = Math.max(0, options.cooldownMs ?? MESSAGE_HISTORY_ORPHAN_SWEEP_COOLDOWN_MS);
    const unavailableReprobeMs = Math.max(
        cooldownMs,
        options.unavailableReprobeMs ?? MESSAGE_HISTORY_ORPHAN_UNAVAILABLE_REPROBE_MS,
    );
    const state = getMessageHistoryOrphanSweepState(db);
    const cursor = typeof state.cursor_session_id === "string" ? state.cursor_session_id : "";
    if (typeof state.last_swept_at === "number" && state.last_swept_at + cooldownMs > now) {
        return { status: "cooldown", scanned: 0, deleted: 0, cursor };
    }

    let openCodeDb: Database | null = null;
    try {
        openCodeDb = openReadableOpenCodeDb();
    } catch {
        openCodeDb = null;
    }
    if (!openCodeDb) {
        // `last_swept_at` delays the next source probe by `unavailableReprobeMs`.
        // after `unavailableReprobeMs`.
        persistMessageHistoryOrphanSweepState(db, cursor, now + unavailableReprobeMs - cooldownMs);
        return { status: "source_unavailable", scanned: 0, deleted: 0, cursor };
    }

    try {
        const cutoff = now - safetyAgeMs;
        const candidates = db
            .prepare(
                `SELECT session_id
                 FROM message_history_index
                 WHERE harness = 'opencode'
                   AND updated_at <= ?
                   AND session_id > ?
                 ORDER BY session_id ASC
                 LIMIT ?`,
            )
            .all(cutoff, cursor, batchSize) as Array<{ session_id: string }>;
        const sessionExists = openCodeDb.prepare("SELECT 1 FROM session WHERE id = ? LIMIT 1");
        const missingSessionIds = candidates
            .filter((candidate) => !sessionExists.get(candidate.session_id))
            .map((candidate) => candidate.session_id);
        const nextCursor =
            candidates.length < batchSize
                ? ""
                : (candidates[candidates.length - 1]?.session_id ?? cursor);
        const completedAt = candidates.length < batchSize ? now : null;

        db.exec("BEGIN IMMEDIATE");
        let committed = false;
        let deleted = 0;
        try {
            const stillEligible = db.prepare(
                "SELECT 1 FROM message_history_index WHERE session_id = ? AND harness = 'opencode' AND updated_at <= ?",
            );
            for (const sessionId of missingSessionIds) {
                if (!stillEligible.get(sessionId, cutoff)) continue;
                getDeleteFtsStatement(db).run(sessionId);
                getDeleteMessageSourceStatement(db).run(sessionId);
                const result = db
                    .prepare(
                        "DELETE FROM message_history_index WHERE session_id = ? AND harness = 'opencode' AND updated_at <= ?",
                    )
                    .run(sessionId, cutoff);
                if (result.changes === 1) deleted += 1;
            }
            persistMessageHistoryOrphanSweepState(db, nextCursor, completedAt);
            db.exec("COMMIT");
            committed = true;
        } finally {
            if (!committed) {
                try {
                    db.exec("ROLLBACK");
                } catch {}
            }
        }

        return {
            status: "swept",
            scanned: candidates.length,
            deleted,
            cursor: nextCursor,
        };
    } finally {
        closeQuietly(openCodeDb);
    }
}
