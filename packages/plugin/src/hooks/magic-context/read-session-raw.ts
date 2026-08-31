import type { Database } from "../../shared/sqlite";

export interface RawMessageParts {
    id: string;
    role: string;
    parts: unknown[];
    createdAt?: number | null;
    version?: string | number | null;
}

export interface RawMessage extends RawMessageParts {
    ordinal: number;
}

export interface RawMessageOrdinalAnchor {
    timeCreated: number;
    id: string;
}

export interface RawMessageOrdinalEntry extends RawMessageOrdinalAnchor {
    contributesOrdinal: boolean;
    hasValidInfo: boolean;
}

interface RawMessageRow {
    id: string;
    data: string;
    time_created?: number;
    time_updated?: number;
}

interface RawPartRow {
    message_id: string;
    data: string;
    time_updated?: number;
}

interface OrdinalRow {
    ordinal?: number;
}

function isRawMessageRow(row: unknown): row is RawMessageRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.id === "string" && typeof candidate.data === "string";
}

function isRawPartRow(row: unknown): row is RawPartRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return typeof candidate.message_id === "string" && typeof candidate.data === "string";
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(value);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

export function isRawCompactionSummaryInfo(info: unknown): boolean {
    if (info === null || typeof info !== "object" || Array.isArray(info)) return false;
    const candidate = info as Record<string, unknown>;
    return candidate.summary === true && candidate.finish === "stop";
}

function parseJsonUnknown(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function attachRawPartVersion(value: unknown, timeUpdated: number | undefined): unknown {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    if (typeof timeUpdated !== "number") return value;
    try {
        Object.defineProperty(value, "__magicContextPartUpdatedAt", {
            value: timeUpdated,
            enumerable: false,
            configurable: true,
        });
    } catch {
    }
    return value;
}

export function readRawSessionMessagesFromDb(db: Database, sessionId: string): RawMessage[] {
    const messageRows = db
        .prepare(
            "SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId)
        .filter(isRawMessageRow);

    const partRows = db
        .prepare(
            "SELECT message_id, data, time_updated FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId)
        .filter(isRawPartRow);

    const partsByMessageId = new Map<string, unknown[]>();
    for (const part of partRows) {
        const list = partsByMessageId.get(part.message_id) ?? [];
        list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
        partsByMessageId.set(part.message_id, list);
    }

    const filtered = messageRows.filter(
        (row) => !isRawCompactionSummaryInfo(parseJsonRecord(row.data)),
    );

    return filtered.flatMap((row, index) => {
        const info = parseJsonRecord(row.data);
        if (!info) return [];
        const role = typeof info.role === "string" ? info.role : "unknown";
        return {
            ordinal: index + 1,
            id: row.id,
            role,
            parts: partsByMessageId.get(row.id) ?? [],
            createdAt: row.time_created ?? null,
            version: row.time_updated ?? null,
        };
    });
}

interface PagedRawMessageRow extends RawMessageRow {
    ordinal: number;
}

/**
 * The page limit bounds JSON parsing and per-call work.
 */
export function readRawSessionMessagePageFromDb(
    db: Database,
    sessionId: string,
    afterOrdinal: number,
    limit: number,
    finalWatermark = Number.MAX_SAFE_INTEGER,
): RawMessage[] {
    const remaining = Math.max(0, Math.floor(finalWatermark) - Math.floor(afterOrdinal));
    const pageSize = Math.min(Math.max(1, Math.floor(limit)), remaining);
    if (pageSize === 0) return [];

    const messageRows = db
        .prepare(
            `SELECT id, data, time_created, time_updated
             FROM message
             WHERE session_id = ?
               AND NOT (
                   CASE WHEN json_valid(data) = 1
                        THEN COALESCE(json_extract(data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(data) = 1
                            THEN COALESCE(json_extract(data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )
             ORDER BY time_created ASC, id ASC
             LIMIT ? OFFSET ?`,
        )
        .all(sessionId, pageSize, Math.max(0, Math.floor(afterOrdinal)))
        .filter(isRawMessageRow)
        .map(
            (row, index): PagedRawMessageRow => ({
                ...row,
                ordinal: Math.floor(afterOrdinal) + index + 1,
            }),
        );

    if (messageRows.length === 0) return [];

    const placeholders = messageRows.map(() => "?").join(", ");
    const partRows = db
        .prepare(
            `SELECT message_id, data, time_updated
             FROM part
             WHERE session_id = ? AND message_id IN (${placeholders})
             ORDER BY time_created ASC, id ASC`,
        )
        .all(sessionId, ...messageRows.map((row) => row.id))
        .filter(isRawPartRow);
    const partsByMessageId = new Map<string, unknown[]>();
    for (const part of partRows) {
        const list = partsByMessageId.get(part.message_id) ?? [];
        list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
        partsByMessageId.set(part.message_id, list);
    }

    return messageRows.map((row) => {
        const info = parseJsonRecord(row.data);
        return {
            ordinal: row.ordinal,
            id: row.id,
            role: typeof info?.role === "string" ? info.role : "unknown",
            parts: partsByMessageId.get(row.id) ?? [],
            createdAt: row.time_created ?? null,
            version: row.time_updated ?? null,
        };
    });
}

export function countRawSessionMessageOrdinalsFromDb(db: Database, sessionId: string): number {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS count
             FROM message
             WHERE session_id = ?
               AND NOT (
                   CASE WHEN json_valid(data) = 1
                        THEN COALESCE(json_extract(data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(data) = 1
                            THEN COALESCE(json_extract(data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )`,
        )
        .get(sessionId) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

/**
 * readRawSessionMessageIdOrdinalsFromDb preserves readRawSessionMessagePageFromDb's ordering, summary predicate, and malformed-message behavior.
 */
export function readRawSessionMessageIdOrdinalsFromDb(
    db: Database,
    sessionId: string,
): Map<string, number> {
    const messageRows = db
        .prepare(
            "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId)
        .filter(isRawMessageRow);
    const ordinalById = new Map<string, number>();
    let ordinal = 0;
    for (const row of messageRows) {
        const info = parseJsonRecord(row.data);
        if (isRawCompactionSummaryInfo(info)) continue;
        ordinal += 1;
        if (info) ordinalById.set(row.id, ordinal);
    }
    return ordinalById;
}

/** The keyset page supports incremental maintenance of shadow message ordinals. */
export function readRawSessionMessageOrdinalPageFromDb(
    db: Database,
    sessionId: string,
    after: RawMessageOrdinalAnchor | null,
    limit: number,
): RawMessageOrdinalEntry[] {
    const pageSize = Math.max(1, Math.floor(limit));
    const rows = (
        after
            ? db
                  .prepare(
                      `SELECT id, data, time_created
                       FROM message
                       WHERE session_id = ?
                         AND (time_created, id) > (?, ?)
                       ORDER BY time_created ASC, id ASC
                       LIMIT ?`,
                  )
                  .all(sessionId, after.timeCreated, after.id, pageSize)
            : db
                  .prepare(
                      `SELECT id, data, time_created
                       FROM message
                       WHERE session_id = ?
                       ORDER BY time_created ASC, id ASC
                       LIMIT ?`,
                  )
                  .all(sessionId, pageSize)
    ).filter(isRawMessageRow);

    return rows.flatMap((row) => {
        if (typeof row.time_created !== "number") return [];
        const info = parseJsonRecord(row.data);
        return {
            id: row.id,
            timeCreated: row.time_created,
            contributesOrdinal: !isRawCompactionSummaryInfo(info),
            hasValidInfo: info !== null,
        };
    });
}

/** The count includes compaction-summary rows. */
export function countStoredRawSessionMessagesFromDb(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?")
        .get(sessionId) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

interface AnchorRow {
    time_created: number;
    id: string;
}

function isAnchorRow(row: unknown): row is AnchorRow {
    return (
        row !== null &&
        typeof row === "object" &&
        typeof (row as { time_created?: unknown }).time_created === "number" &&
        typeof (row as { id?: unknown }).id === "string"
    );
}

/**
 * The function includes the compartment boundary and assigns it ordinal `baseOrdinal`.
 *
 * The compaction marker excludes pre-boundary rows.
 *
 * Including the anchor ensures `messageIdAtOrdinal(baseOrdinal)` returns the boundary message.
 *
 * up.
 */
export function readRawSessionTailFromDb(
    db: Database,
    sessionId: string,
    baseOrdinal: number,
    anchorMessageId: string,
): { messages: RawMessage[]; absoluteMessageCount: number } | null {
    const anchorRow = db
        .prepare("SELECT time_created, id, data FROM message WHERE id = ? AND session_id = ?")
        .get(anchorMessageId, sessionId);
    if (!isAnchorRow(anchorRow)) return null;

    // The `messageIdAtOrdinal` mapping excludes summary anchors because the full reader filters summaries before assigning ordinals.
    // off-by-one window.
    const anchorInfo = parseJsonRecord((anchorRow as { data?: string }).data ?? "");
    if (anchorInfo?.summary === true && anchorInfo?.finish === "stop") return null;

    const messageRows = db
        .prepare(
            `SELECT id, data, time_created, time_updated FROM message
             WHERE session_id = ?
               AND (time_created > ? OR (time_created = ? AND id >= ?))
             ORDER BY time_created ASC, id ASC`,
        )
        .all(sessionId, anchorRow.time_created, anchorRow.time_created, anchorRow.id)
        .filter(isRawMessageRow);

    // Compaction-summary rows do not consume ordinal slots.
    // ordinal assignment.
    const filtered = messageRows.filter((row) => {
        const info = parseJsonRecord(row.data);
        return !(info?.summary === true && info?.finish === "stop");
    });

    const ids = filtered.map((row) => row.id);
    const partsByMessageId = new Map<string, unknown[]>();
    if (ids.length > 0) {
        const CHUNK = 800;
        for (let i = 0; i < ids.length; i += CHUNK) {
            const slice = ids.slice(i, i + CHUNK);
            const placeholders = slice.map(() => "?").join(",");
            const partRows = db
                .prepare(
                    `SELECT message_id, data, time_updated FROM part WHERE session_id = ? AND message_id IN (${placeholders}) ORDER BY time_created ASC, id ASC`,
                )
                .all(sessionId, ...slice)
                .filter(isRawPartRow);
            for (const part of partRows) {
                const list = partsByMessageId.get(part.message_id) ?? [];
                list.push(attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated));
                partsByMessageId.set(part.message_id, list);
            }
        }
    }

    const messages: RawMessage[] = [];
    let ord = baseOrdinal;
    for (const row of filtered) {
        const info = parseJsonRecord(row.data);
        if (!info) {
            // A malformed row consumes an ordinal slot but produces no element.
            ord += 1;
            continue;
        }
        messages.push({
            ordinal: ord,
            id: row.id,
            role: typeof info.role === "string" ? info.role : "unknown",
            parts: partsByMessageId.get(row.id) ?? [],
            createdAt: row.time_created ?? null,
            version: row.time_updated ?? null,
        });
        ord += 1;
    }

    // `ord` points one past the last assigned ordinal, so the absolute count is `ord - 1`.
    return { messages, absoluteMessageCount: Math.max(0, ord - 1) };
}

/**
 * The interface avoids a transform-layer dependency.
 */
export interface InMemoryMessageView {
    id: string;
    role: string;
    parts: unknown[];
    /** `summary` uses message `info` when present to mirror the DB summary filter. */
    summary?: boolean;
    finish?: string;
}

export interface InMemoryTailResult {
    messages: RawMessage[];
    absoluteMessageCount: number;
    /* */
    anchorFound: boolean;
}

/**
 * A malformed row preserves its ordinal but emits no element.
 */
export function extractInMemoryMessageViews(
    messages: readonly { info?: unknown; parts?: unknown }[],
): InMemoryMessageView[] {
    return messages.map((m) => {
        const info = (m.info ?? {}) as Record<string, unknown>;
        return {
            id: typeof info.id === "string" ? info.id : "",
            role: typeof info.role === "string" ? info.role : "unknown",
            parts: Array.isArray(m.parts) ? m.parts : [],
            summary: info.summary === true ? true : undefined,
            finish: typeof info.finish === "string" ? info.finish : undefined,
        };
    });
}

/**
 * The function mirrors {@link readRawSessionTailFromDb} so the boundary resolver can operate without reading opencode.db.
 *
 *
 * - If `anchorMessageId` is found at index k, that message is the boundary.
 * The function assigns the found anchor ordinal `lastCompartmentEnd` and assigns subsequent messages consecutive ordinals.
 * The function drops messages before a found anchor because the DB tail starts at the anchor.
 * When no anchor is found, the first row receives ordinal `max(1, lastCompartmentEnd + 1)`.
 * When no anchor is found, the function assumes the first row follows `lastCompartmentEnd`.
 *
 *
 */
export function buildInMemoryTailRawMessages(args: {
    messages: readonly InMemoryMessageView[];
    lastCompartmentEnd: number;
    anchorMessageId: string | null;
}): InMemoryTailResult | null {
    const { messages, lastCompartmentEnd, anchorMessageId } = args;

    const filtered = messages.filter((m) => !(m.summary === true && m.finish === "stop"));
    if (filtered.length === 0) return null;

    let startIndex = 0;
    let baseOrdinal: number;
    let anchorFound = false;
    if (anchorMessageId) {
        const anchorIndex = filtered.findIndex((m) => m.id === anchorMessageId);
        if (anchorIndex >= 0) {
            anchorFound = true;
            startIndex = anchorIndex;
            baseOrdinal = lastCompartmentEnd; // the anchor row IS lastCompartmentEnd
        } else {
            baseOrdinal = Math.max(1, lastCompartmentEnd + 1);
        }
    } else {
        baseOrdinal = Math.max(1, lastCompartmentEnd + 1);
    }

    const out: RawMessage[] = [];
    let ord = baseOrdinal;
    for (let i = startIndex; i < filtered.length; i += 1) {
        const m = filtered[i];
        if (!m.id || typeof m.id !== "string") {
            ord += 1;
            continue;
        }
        out.push({
            ordinal: ord,
            id: m.id,
            role: typeof m.role === "string" ? m.role : "unknown",
            parts: m.parts ?? [],
            version: null,
        });
        ord += 1;
    }

    return { messages: out, absoluteMessageCount: Math.max(0, ord - 1), anchorFound };
}

export function readRawSessionMessagePartsByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
): RawMessageParts | null {
    const row = db
        .prepare(
            "SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND id = ?",
        )
        .get(sessionId, messageId) as RawMessageRow | null;
    if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number") return null;

    const info = parseJsonRecord(row.data);
    if (!info || isRawCompactionSummaryInfo(info)) return null;
    const partRows = db
        .prepare(
            "SELECT message_id, data, time_updated FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId, messageId)
        .filter(isRawPartRow);
    return {
        id: row.id,
        role: typeof info.role === "string" ? info.role : "unknown",
        parts: partRows.map((part) =>
            attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated),
        ),
        createdAt: row.time_created,
        version: row.time_updated ?? null,
    };
}

/**
 */
export function readRawSessionMessageOrdinalByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
): number | null {
    const row = db
        .prepare(
            `SELECT COUNT(candidate.id) AS ordinal
             FROM message AS target
             JOIN message AS candidate
               ON candidate.session_id = target.session_id
              AND NOT (
                  CASE WHEN json_valid(candidate.data) = 1
                       THEN COALESCE(json_extract(candidate.data, '$.summary'), 0)
                       ELSE 0 END = 1
                  AND CASE WHEN json_valid(candidate.data) = 1
                           THEN COALESCE(json_extract(candidate.data, '$.finish'), '')
                           ELSE '' END = 'stop'
              )
              AND (candidate.time_created < target.time_created
                   OR (candidate.time_created = target.time_created AND candidate.id <= target.id))
             WHERE target.session_id = ?
               AND target.id = ?
               AND NOT (
                   CASE WHEN json_valid(target.data) = 1
                        THEN COALESCE(json_extract(target.data, '$.summary'), 0)
                        ELSE 0 END = 1
                   AND CASE WHEN json_valid(target.data) = 1
                            THEN COALESCE(json_extract(target.data, '$.finish'), '')
                            ELSE '' END = 'stop'
               )`,
        )
        .get(sessionId, messageId) as OrdinalRow | null;
    const ordinal = row?.ordinal;
    return typeof ordinal === "number" && ordinal > 0 ? ordinal : null;
}

export function readRawSessionMessageByIdFromDb(
    db: Database,
    sessionId: string,
    messageId: string,
): RawMessage | null {
    const row = db
        .prepare(
            "SELECT id, data, time_created, time_updated FROM message WHERE session_id = ? AND id = ?",
        )
        .get(sessionId, messageId) as RawMessageRow | null;
    if (!row || !isRawMessageRow(row) || typeof row.time_created !== "number") {
        return null;
    }

    const info = parseJsonRecord(row.data);
    if (!info || isRawCompactionSummaryInfo(info)) {
        return null;
    }

    const ordinalRow = db
        .prepare(
            `SELECT COUNT(*) AS ordinal FROM message
             WHERE session_id = ?
               AND NOT (COALESCE(json_extract(data, '$.summary'), 0) = 1
                        AND COALESCE(json_extract(data, '$.finish'), '') = 'stop')
               AND (time_created < ? OR (time_created = ? AND id <= ?))`,
        )
        .get(sessionId, row.time_created, row.time_created, messageId) as OrdinalRow | null;
    const ordinal = typeof ordinalRow?.ordinal === "number" ? ordinalRow.ordinal : 0;
    if (ordinal <= 0) {
        return null;
    }

    const partRows = db
        .prepare(
            "SELECT message_id, data, time_updated FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created ASC, id ASC",
        )
        .all(sessionId, messageId)
        .filter(isRawPartRow);

    const role = typeof info.role === "string" ? info.role : "unknown";
    return {
        ordinal,
        id: row.id,
        role,
        parts: partRows.map((part) =>
            attachRawPartVersion(parseJsonUnknown(part.data), part.time_updated),
        ),
        createdAt: row.time_created,
        version: row.time_updated ?? null,
    };
}
