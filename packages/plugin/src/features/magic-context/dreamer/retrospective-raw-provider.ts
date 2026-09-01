import { cleanUserText } from "../../../hooks/magic-context/read-session-chunk";
import { hasMeaningfulUserText } from "../../../hooks/magic-context/read-session-formatting";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { openOpenCodeDb } from "./open-opencode-db";

export const RETROSPECTIVE_MAX_MESSAGES_PER_SESSION = 80;
export const RETROSPECTIVE_MAX_MESSAGES_PER_RUN = 240;
// The `watermark=0` run scans at most 20 oldest eligible sessions to bound I/O.
// Without the cap, `watermark=0` scans the project's entire session history.
// The cap bounds scan I/O regardless of session count.
export const RETROSPECTIVE_MAX_SESSIONS_PER_RUN = 20;

export type RetrospectiveMessageRole = "user" | "assistant" | "tool";

export interface RetrospectiveProjectSession {
    sessionId: string;
    path?: string;
    updatedAt?: number;
}

export interface RetrospectiveRawMessage {
    sessionId: string;
    ordinal: number;
    role: RetrospectiveMessageRole;
    text: string;
    toolName?: string;
    isError?: boolean;
    ts: number;
}

/** `truncated` is true only when the read reaches `capPerSession` with additional rows available.
 * The provider must not infer `truncated` from `messages.length`.
 * Normalization can drop assistant and empty rows.
 * Normalization can expand one assistant message into multiple tool rows.
 * */
export interface RetrospectiveSinceRead {
    messages: RetrospectiveRawMessage[];
    truncated: boolean;
}

export interface RetrospectiveRawProvider {
    listProjectSessions(
        projectIdentity: string,
    ): RetrospectiveProjectSession[] | Promise<RetrospectiveProjectSession[]>;
    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveSinceRead | Promise<RetrospectiveSinceRead>;
    /** Indexed providers use each session's oldest pending raw-message timestamp to order bounded scans.
     * The pending-message frontier is more precise than session `updated_at`. */
    readOldestMessageTimesSince?(
        sessionIds: readonly string[],
        sinceMs: number,
    ): Map<string, number> | Promise<Map<string, number>>;
    /** `readUserMessagesBefore` returns up to `count` typed user messages at or before `beforeMs`.
     * The overlap prevents missing friction that spans two runs. */
    readUserMessagesBefore(
        sessionId: string,
        beforeMs: number,
        count: number,
    ): RetrospectiveRawMessage[] | Promise<RetrospectiveRawMessage[]>;
    /** `dispose` releases reused resources after a run. */
    dispose?(): void;
}

interface OpenCodeRetrospectiveRawProviderDeps {
    contextDb: Database;
    openOpenCodeDb?: () => Database | null;
    /** The provider does not close a test-supplied `opencodeDb`. */
    opencodeDb?: Database;
}

interface SessionProjectRow {
    session_id: string;
    updated_at?: number | null;
}

interface OpenCodeMessageRow {
    id: string;
    data: string;
    time_created: number;
}

interface OpenCodePartRow {
    message_id: string;
    data: string;
}

export class OpenCodeRetrospectiveRawProvider implements RetrospectiveRawProvider {
    private readonly openDb: () => Database | null;
    // `sharedDb` reuses one read-only OpenCode database handle for per-session reads.
    // `sharedDb` opens on the first read and closes in `dispose`.
    // Reusing the handle avoids one open/close cycle per session.
    private sharedDb: Database | null = null;
    private sharedDbOpened = false;

    constructor(private readonly deps: OpenCodeRetrospectiveRawProviderDeps) {
        this.openDb = deps.openOpenCodeDb ?? openOpenCodeDb;
    }

    listProjectSessions(projectIdentity: string): RetrospectiveProjectSession[] {
        // Only root sessions are eligible.
        // `is_subagent` is stored in same-database `session_meta`; the provider treats missing metadata as root.
        const rows = this.deps.contextDb
            .prepare<[string], SessionProjectRow>(
                `SELECT sp.session_id, sp.updated_at
                   FROM session_projects sp
                   LEFT JOIN session_meta m ON m.session_id = sp.session_id
                  WHERE sp.project_path = ? AND sp.harness = 'opencode'
                    AND COALESCE(m.is_subagent, 0) = 0
                  ORDER BY sp.updated_at ASC, sp.session_id ASC`,
            )
            .all(projectIdentity);
        return rows.map((row) => ({
            sessionId: row.session_id,
            updatedAt: typeof row.updated_at === "number" ? row.updated_at : undefined,
        }));
    }

    private resolveDb(): Database | null {
        if (this.deps.opencodeDb) return this.deps.opencodeDb;
        if (!this.sharedDbOpened) {
            this.sharedDbOpened = true;
            this.sharedDb = this.openDb();
        }
        return this.sharedDb;
    }

    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveSinceRead {
        const db = this.resolveDb();
        if (!db) return { messages: [], truncated: false };
        try {
            return readOpenCodeMessagesSince(db, sessionId, sinceMs, capPerSession);
        } catch {
            return { messages: [], truncated: false };
        }
    }

    readOldestMessageTimesSince(
        sessionIds: readonly string[],
        sinceMs: number,
    ): Map<string, number> {
        const db = this.resolveDb();
        if (!db || sessionIds.length === 0) return new Map();
        return readOpenCodeOldestMessageTimesSince(db, sessionIds, sinceMs);
    }

    readUserMessagesBefore(
        sessionId: string,
        beforeMs: number,
        count: number,
    ): RetrospectiveRawMessage[] {
        const db = this.resolveDb();
        if (!db) return [];
        try {
            return readOpenCodeUserMessagesBefore(db, sessionId, beforeMs, count);
        } catch {
            return [];
        }
    }

    /** `dispose` may be called multiple times without throwing. */
    dispose(): void {
        if (this.sharedDb && !this.deps.opencodeDb) {
            closeQuietly(this.sharedDb);
        }
        this.sharedDb = null;
        this.sharedDbOpened = false;
    }
}

export interface RetrospectiveScanWindow {
    /** All scanned messages, including user rows and tool metadata, are ordered oldest to newest and assigned global ordinals.
     * `messages` includes the user-only pre-watermark overlap. */
    messages: RetrospectiveRawMessage[];
    /** The persisted content watermark never falls below `watermarkMs`; when messages are scanned, it is their largest timestamp.
     * */
    maxScannedTs: number;
}

/**
 * A run includes messages newer than `watermarkMs` and the preceding `overlapUserCount` user messages for sessions with new rows, so friction spanning runs remains visible.
 * The since portion contains user rows and tool metadata for deepening context; the overlap portion contains only user rows for gate context. The provider reassigns ordinals globally.
 */
export async function readRetrospectiveScanWindow(
    provider: RetrospectiveRawProvider,
    projectIdentity: string,
    watermarkMs: number,
    overlapUserCount: number,
    options?: {
        maxMessagesPerRun?: number;
        capPerSession?: number;
        maxSessionsPerRun?: number;
    },
): Promise<RetrospectiveScanWindow> {
    const maxMessages = options?.maxMessagesPerRun ?? RETROSPECTIVE_MAX_MESSAGES_PER_RUN;
    const capPerSession = options?.capPerSession ?? RETROSPECTIVE_MAX_MESSAGES_PER_SESSION;
    const sessionLimit = Math.max(
        1,
        Math.floor(options?.maxSessionsPerRun ?? RETROSPECTIVE_MAX_SESSIONS_PER_RUN),
    );
    try {
        const allSessions = await provider.listProjectSessions(projectIdentity);
        const eligibleSessions = allSessions
            .map((session, index) => ({ session, index }))
            .filter(({ session }) => (session.updatedAt ?? Number.POSITIVE_INFINITY) > watermarkMs);
        const oldestBySession = provider.readOldestMessageTimesSince
            ? await provider.readOldestMessageTimesSince(
                  eligibleSessions.map(({ session }) => session.sessionId),
                  watermarkMs,
              )
            : null;
        const sessions = (
            oldestBySession
                ? eligibleSessions.filter(({ session }) => oldestBySession.has(session.sessionId))
                : eligibleSessions
        ).sort((a, b) => {
            const aFrontier = oldestBySession?.get(a.session.sessionId);
            const bFrontier = oldestBySession?.get(b.session.sessionId);
            if (aFrontier !== undefined || bFrontier !== undefined) {
                return (
                    (aFrontier ?? Number.POSITIVE_INFINITY) -
                        (bFrontier ?? Number.POSITIVE_INFINITY) || a.index - b.index
                );
            }
            const aUpdated = a.session.updatedAt ?? Number.POSITIVE_INFINITY;
            const bUpdated = b.session.updatedAt ?? Number.POSITIVE_INFINITY;
            const byUpdated = aUpdated - bUpdated;
            return byUpdated || a.index - b.index;
        });
        const sessionsToRead = sessions.slice(0, sessionLimit).map(({ session }) => session);
        const firstExcludedSession = sessions[sessionLimit]?.session;
        const firstExcludedPendingTs = firstExcludedSession
            ? oldestBySession?.get(firstExcludedSession.sessionId)
            : undefined;
        const sinceReads: RetrospectiveSinceRead[] = [];
        if (sessionsToRead.length > 0) {
            sinceReads.push(
                ...(await Promise.all(
                    sessionsToRead.map((session) =>
                        provider.readUserMessagesSince(
                            session.sessionId,
                            watermarkMs,
                            capPerSession,
                        ),
                    ),
                )),
            );
        }

        // A truncated read reached its per-session cap and has additional rows.
        // A truncated read can leave messages at `lastKept.ts` unread.
        // Advancing the watermark past lastKept.ts would skip unread messages.
        // The provider uses `lastKept.ts - 1` to reread same-millisecond messages.
        // Only read.truncated signals SQL-level truncation.
        let saturatedFrontier = Number.POSITIVE_INFINITY;
        for (const read of sinceReads) {
            const lastKept = read.truncated ? read.messages[read.messages.length - 1] : undefined;
            if (lastKept) {
                saturatedFrontier = Math.min(saturatedFrontier, lastKept.ts - 1);
            }
        }
        // The global cap keeps the oldest allSince messages so a backlog drains from the front.
        // Newest-first capping would skip older rows when the watermark advances to the newest kept timestamp.
        const allSince = sinceReads
            .flatMap((read) => read.messages)
            .sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
        const keptSince = allSince.slice(0, maxMessages);
        const droppedSince = allSince.slice(maxMessages);

        // The next watermark is the newest kept timestamp, clamped below incomplete frontiers.
        // The exclusive > watermark filter must not skip pending work.
        // Three truncation sources can split the eligible backlog.
        // The global maxMessages cap limits the watermark to droppedSince[0].ts - 1.
        // This limit is a no-op when droppedSince[0].ts is newer than the newest kept timestamp.
        // Per-session saturation limits the watermark to saturatedFrontier.
        // The session cap limits the watermark to the first excluded session's oldest pending timestamp minus 1.
        // When no indexed pending frontier exists, the session cap falls back to firstExcludedSession.updatedAt - 1.
        // Oldest-frontier-first scanning prevents the watermark clamp from starving an excluded session.
        // The watermark uses the tightest frontier and never decreases.
        let maxScannedTs = watermarkMs;
        for (const row of keptSince) {
            if (row.ts > maxScannedTs) maxScannedTs = row.ts;
        }
        let frontier = saturatedFrontier;
        const firstDropped = droppedSince[0];
        if (firstDropped) {
            frontier = Math.min(frontier, firstDropped.ts - 1);
        }
        if (typeof firstExcludedPendingTs === "number") {
            frontier = Math.min(frontier, firstExcludedPendingTs - 1);
        } else if (typeof firstExcludedSession?.updatedAt === "number") {
            frontier = Math.min(frontier, firstExcludedSession.updatedAt - 1);
        }
        maxScannedTs = Math.max(watermarkMs, Math.min(maxScannedTs, frontier));

        const keptSessionIds = new Set(keptSince.map((message) => message.sessionId));
        const overlapSessions = sessionsToRead.filter((session) =>
            keptSessionIds.has(session.sessionId),
        );
        const overlapBatches =
            overlapUserCount > 0 && watermarkMs > 0
                ? await Promise.all(
                      overlapSessions.map((session) =>
                          provider.readUserMessagesBefore(
                              session.sessionId,
                              watermarkMs,
                              overlapUserCount,
                          ),
                      ),
                  )
                : [];

        // The overlap reads at most kept-session count × overlapUserCount rows.
        // Overlap rows are ≤ watermark so they never affect maxScannedTs.
        const seen = new Set<string>();
        const merged: RetrospectiveRawMessage[] = [];
        for (const row of [...keptSince, ...overlapBatches.flat()]) {
            const key = `${row.sessionId}\u0000${row.ts}\u0000${row.role}\u0000${row.toolName ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(row);
        }
        merged.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
        return { messages: merged, maxScannedTs };
    } finally {
        provider.dispose?.();
    }
}

function readOpenCodeMessagesSince(
    db: Database,
    sessionId: string,
    sinceMs: number,
    capPerSession: number,
): RetrospectiveSinceRead {
    const limit = Math.max(1, Math.floor(capPerSession));
    // The cap keeps the oldest post-watermark messages so the watermark advances through a backlog in bounded chunks.
    // Reading newest-first skips older rows when the watermark advances to the newest row.
    // Reading limit + 1 distinguishes truncation from exactly limit rows.
    const rows = db
        .prepare<[string, number, number], OpenCodeMessageRow>(
            `SELECT id, data, time_created
               FROM message
              WHERE session_id = ? AND time_created > ?
              ORDER BY time_created ASC, id ASC
              LIMIT ?`,
        )
        .all(sessionId, sinceMs, limit + 1);
    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;
    return { messages: normalizeOpenCodeRows(db, sessionId, kept), truncated };
}

function readOpenCodeOldestMessageTimesSince(
    db: Database,
    sessionIds: readonly string[],
    sinceMs: number,
): Map<string, number> {
    const result = new Map<string, number>();
    const uniqueIds = Array.from(new Set(sessionIds.filter((id) => id.length > 0)));
    const chunkSize = 500;
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const chunk = uniqueIds.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = db
            .prepare<unknown[], { session_id: string; oldest_ts: number }>(
                `SELECT session_id, MIN(time_created) AS oldest_ts
                   FROM message
                  WHERE time_created > ? AND session_id IN (${placeholders})
                  GROUP BY session_id`,
            )
            .all(sinceMs, ...chunk);
        for (const row of rows) {
            if (typeof row.oldest_ts === "number") result.set(row.session_id, row.oldest_ts);
        }
    }
    return result;
}

/**
 * Returns up to `want` most recent typed USER messages at or before `beforeMs`.
 * The overlap read over-reads mixed row types before retaining USER messages.
 * The friction gate consumes only USER-message overlap.
 */
function readOpenCodeUserMessagesBefore(
    db: Database,
    sessionId: string,
    beforeMs: number,
    count: number,
): RetrospectiveRawMessage[] {
    const want = Math.max(1, Math.floor(count));
    const window = Math.max(want * 5, 32);
    const rows = db
        .prepare<[string, number, number], OpenCodeMessageRow>(
            `SELECT id, data, time_created
               FROM message
              WHERE session_id = ? AND time_created <= ?
              ORDER BY time_created DESC, id DESC
              LIMIT ?`,
        )
        .all(sessionId, beforeMs, window)
        .reverse();
    const userRows = normalizeOpenCodeRows(db, sessionId, rows).filter((r) => r.role === "user");
    return userRows.slice(-want);
}

function normalizeOpenCodeRows(
    db: Database,
    sessionId: string,
    rows: OpenCodeMessageRow[],
): RetrospectiveRawMessage[] {
    if (rows.length === 0) return [];

    // The query restricts part reads to retained message IDs; long sessions contain parts for other messages.
    const messageIds = rows.map((row) => row.id);
    const placeholders = messageIds.map(() => "?").join(", ");
    const partRows = db
        .prepare<string[], OpenCodePartRow>(
            `SELECT message_id, data
               FROM part
              WHERE session_id = ? AND message_id IN (${placeholders})
              ORDER BY time_created ASC, id ASC`,
        )
        .all(sessionId, ...messageIds);
    const partsByMessageId = new Map<string, unknown[]>();
    for (const row of partRows) {
        const parts = partsByMessageId.get(row.message_id) ?? [];
        const parsed = parseJson(row.data);
        if (parsed !== null) parts.push(parsed);
        partsByMessageId.set(row.message_id, parts);
    }

    return rows.flatMap((row, index) => {
        const messageData = parseJsonRecord(row.data);
        if (!messageData) return [];
        if (messageData.summary === true && messageData.finish === "stop") return [];
        const role = typeof messageData.role === "string" ? messageData.role : "unknown";
        const parts = partsByMessageId.get(row.id) ?? [];
        const ordinal = index + 1;
        return normalizeOpenCodeMessage({
            sessionId,
            ordinal,
            role,
            parts,
            ts: row.time_created,
        });
    });
}

function normalizeOpenCodeMessage(args: {
    sessionId: string;
    ordinal: number;
    role: string;
    parts: unknown[];
    ts: number;
}): RetrospectiveRawMessage[] {
    const rows: RetrospectiveRawMessage[] = [];
    // Retrospective reads access raw history from other sessions.
    // Only typed USER text may enter the friction window.
    // Assistant text and raw tool output never enter the friction window.
    // Tool rows emit only name and error metadata.
    if (args.role === "user") {
        const text = extractGenuineUserText(args.parts);
        if (text) {
            rows.push({
                sessionId: args.sessionId,
                ordinal: args.ordinal,
                role: "user",
                text,
                ts: args.ts,
            });
        }
    }

    for (const tool of extractToolRows(args.parts)) {
        rows.push({
            sessionId: args.sessionId,
            ordinal: args.ordinal,
            role: "tool",
            text: "",
            toolName: tool.toolName,
            isError: tool.isError,
            ts: args.ts,
        });
    }

    return rows;
}

function extractGenuineUserText(parts: unknown[]): string {
    const nonSyntheticParts = parts.filter((part) => {
        if (part === null || typeof part !== "object" || Array.isArray(part)) return true;
        const record = part as Record<string, unknown>;
        return record.synthetic !== true;
    });
    if (!hasMeaningfulUserText(nonSyntheticParts)) return "";
    return extractPlainText(nonSyntheticParts)
        .map((text) => cleanUserText(text))
        .filter((text) => text.length > 0)
        .join("\n")
        .trim();
}

function extractPlainText(parts: unknown[]): string[] {
    const texts: string[] = [];
    for (const part of parts) {
        if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "text") continue;
        if (record.ignored === true || record.synthetic === true) continue;
        if (typeof record.text === "string" && record.text.trim().length > 0) {
            texts.push(record.text.trim());
        }
    }
    return texts;
}

function extractToolRows(parts: unknown[]): Array<{
    toolName: string;
    text: string;
    isError: boolean;
}> {
    const rows: Array<{ toolName: string; text: string; isError: boolean }> = [];
    for (const part of parts) {
        if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "tool" || typeof record.tool !== "string") continue;
        const state = record.state;
        const stateRecord =
            state && typeof state === "object" ? (state as Record<string, unknown>) : {};
        const output = stringifyToolOutput(stateRecord.output);
        const errorText = stringifyToolOutput(stateRecord.error);
        const status = typeof stateRecord.status === "string" ? stateRecord.status : "";
        const isError =
            stateRecord.isError === true ||
            status.toLowerCase() === "error" ||
            errorText.length > 0 ||
            /\b(error|failed|exception|traceback)\b/i.test(output);
        rows.push({
            toolName: record.tool,
            text: output || errorText || `tool ${record.tool}`,
            isError,
        });
    }
    return rows;
}

function stringifyToolOutput(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (value === null || value === undefined) return "";
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function parseJson(value: string): unknown | null {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
    const parsed = parseJson(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
}
