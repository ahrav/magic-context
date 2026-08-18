import { getHarness } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";

export type NoteType = "session" | "smart";
export type NoteStatus = "active" | "pending" | "ready" | "dismissed";
export type NoteCheckStatus = "uncompiled" | "compiled" | "failing" | "fallback";
export type ConditionCompileStatus = "compiled" | "plain" | "refused";

export interface Note {
    id: number;
    type: NoteType;
    status: NoteStatus;
    content: string;
    sessionId: string | null;
    projectPath: string | null;
    surfaceCondition: string | null;
    compiledProvider: string | null;
    compiledConfig: string | null;
    compiledAt: number | null;
    compileStatus: ConditionCompileStatus | null;
    createdAt: number;
    updatedAt: number;
    lastCheckedAt: number | null;
    readyAt: number | null;
    readyReason: string | null;
    /** Message ordinal of the live tail when the note was written, so the note
     *  can be traced back to the conversation that produced it. The agent reads
     *  this as the upper bound and expands `anchorOrdinal - x .. anchorOrdinal`
     *  via ctx_expand at its own discretion. Null for notes written before this
     *  was tracked, or when the session had no indexed messages yet. */
    anchorOrdinal: number | null;
    compiledCheck: string | null;
    manifestJson: string | null;
    checkHash: string | null;
    checkCron: string | null;
    checkVersion: number | null;
    checkStatus: NoteCheckStatus | null;
    checkFailureCount: number;
    checkNetworkFailureCount: number;
    checkQuarantinedUntil: number | null;
    checkNextDueAt: number | null;
    checkCompiledAt: number | null;
    checkFalseSinceAt: number | null;
    checkLastLivenessAt: number | null;
    policyVersion: number | null;
}

export interface GetNotesOptions {
    sessionId?: string;
    projectPath?: string;
    type?: NoteType;
    status?: NoteStatus | NoteStatus[];
}

export interface NoteMutationScope {
    sessionId: string;
    projectPath: string;
}

export interface UpdateNoteOptions {
    content?: string;
    sessionId?: string | null;
    projectPath?: string | null;
    surfaceCondition?: string | null;
    status?: NoteStatus;
    lastCheckedAt?: number | null;
    readyAt?: number | null;
    readyReason?: string | null;
    compiledProvider?: string | null;
    compiledConfig?: string | null;
    compiledAt?: number | null;
    compileStatus?: ConditionCompileStatus | null;
}

interface NoteRow {
    id: number;
    type: string;
    status: string;
    content: string;
    session_id: string | null;
    project_path: string | null;
    surface_condition: string | null;
    compiled_provider?: string | null;
    compiled_config?: string | null;
    compiled_at?: number | null;
    compile_status?: string | null;
    created_at: number;
    updated_at: number;
    last_checked_at: number | null;
    ready_at: number | null;
    ready_reason: string | null;
    anchor_ordinal?: number | null;
    compiled_check?: string | null;
    manifest_json?: string | null;
    check_hash?: string | null;
    check_cron?: string | null;
    check_version?: number | null;
    check_status?: string | null;
    check_failure_count?: number | null;
    check_network_failure_count?: number | null;
    check_quarantined_until?: number | null;
    check_next_due_at?: number | null;
    check_compiled_at?: number | null;
    check_false_since_at?: number | null;
    check_last_liveness_at?: number | null;
    policy_version?: number | null;
}

interface SessionNoteInput {
    sessionId: string;
    content: string;
    anchorOrdinal?: number | null;
}

interface SmartNoteInput {
    content: string;
    sessionId?: string;
    projectPath: string;
    surfaceCondition: string;
    anchorOrdinal?: number | null;
    compiledProvider?: string | null;
    compiledConfig?: string | null;
    compiledAt?: number | null;
    compileStatus?: ConditionCompileStatus | null;
}

const NOTE_TYPES = new Set<NoteType>(["session", "smart"]);
const NOTE_STATUSES = new Set<NoteStatus>(["active", "pending", "ready", "dismissed"]);
const NOTE_CHECK_STATUSES = new Set<NoteCheckStatus>([
    "uncompiled",
    "compiled",
    "failing",
    "fallback",
]);
const CONDITION_COMPILE_STATUSES = new Set<ConditionCompileStatus>([
    "compiled",
    "plain",
    "refused",
]);
const DEFAULT_SMART_STATUSES: NoteStatus[] = ["pending", "ready"];

function toNullableString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

function toNullableNumber(value: unknown): number | null {
    return typeof value === "number" ? value : null;
}

function isNoteRow(row: unknown): row is NoteRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.type === "string" &&
        NOTE_TYPES.has(candidate.type as NoteType) &&
        typeof candidate.status === "string" &&
        NOTE_STATUSES.has(candidate.status as NoteStatus) &&
        typeof candidate.content === "string" &&
        (candidate.session_id === null || typeof candidate.session_id === "string") &&
        (candidate.project_path === null || typeof candidate.project_path === "string") &&
        (candidate.surface_condition === null || typeof candidate.surface_condition === "string") &&
        typeof candidate.created_at === "number" &&
        typeof candidate.updated_at === "number" &&
        (candidate.last_checked_at === null || typeof candidate.last_checked_at === "number") &&
        (candidate.ready_at === null || typeof candidate.ready_at === "number") &&
        (candidate.ready_reason === null || typeof candidate.ready_reason === "string")
    );
}

function toNote(row: NoteRow): Note {
    return {
        id: row.id,
        type: row.type as NoteType,
        status: row.status as NoteStatus,
        content: row.content,
        sessionId: toNullableString(row.session_id),
        projectPath: toNullableString(row.project_path),
        surfaceCondition: toNullableString(row.surface_condition),
        compiledProvider: toNullableString(row.compiled_provider),
        compiledConfig: toNullableString(row.compiled_config),
        compiledAt: toNullableNumber(row.compiled_at),
        compileStatus:
            typeof row.compile_status === "string" &&
            CONDITION_COMPILE_STATUSES.has(row.compile_status as ConditionCompileStatus)
                ? (row.compile_status as ConditionCompileStatus)
                : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastCheckedAt: toNullableNumber(row.last_checked_at),
        readyAt: toNullableNumber(row.ready_at),
        readyReason: toNullableString(row.ready_reason),
        anchorOrdinal: toNullableNumber(row.anchor_ordinal),
        compiledCheck: toNullableString(row.compiled_check),
        manifestJson: toNullableString(row.manifest_json),
        checkHash: toNullableString(row.check_hash),
        checkCron: toNullableString(row.check_cron),
        checkVersion: toNullableNumber(row.check_version),
        checkStatus:
            typeof row.check_status === "string" &&
            NOTE_CHECK_STATUSES.has(row.check_status as NoteCheckStatus)
                ? (row.check_status as NoteCheckStatus)
                : null,
        checkFailureCount: toNullableNumber(row.check_failure_count) ?? 0,
        checkNetworkFailureCount: toNullableNumber(row.check_network_failure_count) ?? 0,
        checkQuarantinedUntil: toNullableNumber(row.check_quarantined_until),
        checkNextDueAt: toNullableNumber(row.check_next_due_at),
        checkCompiledAt: toNullableNumber(row.check_compiled_at),
        checkFalseSinceAt: toNullableNumber(row.check_false_since_at),
        checkLastLivenessAt: toNullableNumber(row.check_last_liveness_at),
        policyVersion: toNullableNumber(row.policy_version),
    };
}

function noteCheckColumnsExist(db: Database): boolean {
    try {
        const rows = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name?: string }>;
        return rows.some((row) => row.name === "compiled_check");
    } catch {
        return false;
    }
}

function getNoteById(db: Database, noteId: number): Note | null {
    const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId);
    return isNoteRow(row) ? toNote(row) : null;
}

function noteBelongsToScope(note: Note, scope: NoteMutationScope): boolean {
    if (note.type === "session") {
        return note.sessionId === scope.sessionId;
    }

    return note.projectPath === scope.projectPath;
}

function buildStatusClause(status: GetNotesOptions["status"]): {
    sql: string;
    params: NoteStatus[];
} | null {
    if (status === undefined) {
        return null;
    }
    const statuses = Array.isArray(status) ? status : [status];
    if (statuses.length === 0) {
        return null;
    }
    const placeholders = statuses.map(() => "?").join(", ");
    return {
        sql: `status IN (${placeholders})`,
        params: statuses,
    };
}

export function getNotes(db: Database, options: GetNotesOptions = {}): Note[] {
    const clauses: string[] = [];
    const params: Array<string | NoteStatus> = [];

    if (options.sessionId !== undefined) {
        clauses.push("session_id = ?");
        params.push(options.sessionId);
    }
    if (options.projectPath !== undefined) {
        clauses.push("project_path = ?");
        params.push(options.projectPath);
    }
    if (options.type !== undefined) {
        clauses.push("type = ?");
        params.push(options.type);
    }

    const statusClause = buildStatusClause(options.status);
    if (statusClause) {
        clauses.push(statusClause.sql);
        params.push(...statusClause.params);
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (
        db
            .prepare(`SELECT * FROM notes${where} ORDER BY created_at ASC, id ASC`)
            .all(...params) as unknown[]
    )
        .filter(isNoteRow)
        .map(toNote);
}

const NOTE_SEARCH_STATUSES: NoteStatus[] = ["active", "pending", "ready", "dismissed"];

function notesProjectionExists(db: Database): boolean {
    const row = db
        .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts' LIMIT 1",
        )
        .get() as { present?: number } | null;
    return row?.present === 1;
}

/** Candidate rowids for one FTS query, or null when the projection is absent so
 *  the caller falls back to a scoped scan. */
export function selectNoteCandidateIds(db: Database, ftsQuery: string): number[] | null {
    if (!notesProjectionExists(db)) return null;
    if (ftsQuery.length === 0) return [];
    try {
        const rows = db
            .prepare("SELECT rowid AS id FROM notes_fts WHERE notes_fts MATCH ?")
            .all(ftsQuery) as Array<{ id?: number }>;
        return rows
            .map((row) => row.id)
            .filter((id): id is number => typeof id === "number" && Number.isFinite(id));
    } catch {
        return null;
    }
}

/** Notes in the caller's search scope restricted to `ids`, ordered as a scoped
 *  scan would return them. */
export function getSearchableNotesByIds(
    db: Database,
    options: { ids: readonly number[]; sessionId: string; projectPath: string },
): Note[] {
    if (options.ids.length === 0) return [];
    const statusPlaceholders = NOTE_SEARCH_STATUSES.map(() => "?").join(", ");
    return (
        db
            .prepare(
                `SELECT notes.* FROM json_each(?) AS requested
                  CROSS JOIN notes ON notes.id = requested.value
                  WHERE notes.status IN (${statusPlaceholders})
                    AND ((notes.type = 'session' AND notes.session_id = ?)
                      OR (notes.type = 'smart' AND notes.project_path = ?))
                  ORDER BY notes.created_at ASC, notes.id ASC`,
            )
            .all(
                JSON.stringify([...options.ids]),
                ...NOTE_SEARCH_STATUSES,
                options.sessionId,
                options.projectPath,
            ) as unknown[]
    )
        .filter(isNoteRow)
        .map(toNote);
}

/** Size of the scoped searchable corpus. */
export function countSearchableNotes(
    db: Database,
    options: { sessionId: string; projectPath: string },
): number {
    const statusPlaceholders = NOTE_SEARCH_STATUSES.map(() => "?").join(", ");
    const row = db
        .prepare(
            `SELECT (SELECT COUNT(*) FROM notes
                      WHERE type = 'session' AND session_id = ?
                        AND status IN (${statusPlaceholders}))
                  + (SELECT COUNT(*) FROM notes
                      WHERE type = 'smart' AND project_path = ?
                        AND status IN (${statusPlaceholders})) AS count`,
        )
        .get(
            options.sessionId,
            ...NOTE_SEARCH_STATUSES,
            options.projectPath,
            ...NOTE_SEARCH_STATUSES,
        ) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

export function addNote(db: Database, type: "session", options: SessionNoteInput): Note;
export function addNote(db: Database, type: "smart", options: SmartNoteInput): Note;
export function addNote(
    db: Database,
    type: NoteType,
    options: SessionNoteInput | SmartNoteInput,
): Note {
    const now = Date.now();
    const result =
        type === "session"
            ? db
                  .prepare(
                      "INSERT INTO notes (type, status, content, session_id, created_at, updated_at, harness, anchor_ordinal) VALUES ('session', 'active', ?, ?, ?, ?, ?, ?) RETURNING *",
                  )
                  .get(
                      options.content,
                      (options as SessionNoteInput).sessionId,
                      now,
                      now,
                      getHarness(),
                      (options as SessionNoteInput).anchorOrdinal ?? null,
                  )
            : db
                  .prepare(
                      "INSERT INTO notes (type, status, content, session_id, project_path, surface_condition, compiled_provider, compiled_config, compiled_at, compile_status, created_at, updated_at, harness, anchor_ordinal) VALUES ('smart', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
                  )
                  .get(
                      options.content,
                      (options as SmartNoteInput).sessionId ?? null,
                      (options as SmartNoteInput).projectPath,
                      (options as SmartNoteInput).surfaceCondition,
                      (options as SmartNoteInput).compiledProvider ?? null,
                      (options as SmartNoteInput).compiledConfig ?? null,
                      (options as SmartNoteInput).compiledAt ?? null,
                      (options as SmartNoteInput).compileStatus ?? null,
                      now,
                      now,
                      getHarness(),
                      (options as SmartNoteInput).anchorOrdinal ?? null,
                  );

    if (!isNoteRow(result)) {
        throw new Error("[notes] failed to insert note");
    }

    return toNote(result);
}

export function getSessionNotes(db: Database, sessionId: string): Note[] {
    return getNotes(db, { sessionId, type: "session", status: "active" });
}

export function getSmartNotes(db: Database, projectPath: string, status?: NoteStatus): Note[] {
    return getNotes(db, {
        projectPath,
        type: "smart",
        status: status ?? DEFAULT_SMART_STATUSES,
    });
}

export function getPendingSmartNotes(db: Database, projectPath: string): Note[] {
    return getSmartNotes(db, projectPath, "pending");
}

export function getReadySmartNotes(db: Database, projectPath: string): Note[] {
    return getSmartNotes(db, projectPath, "ready");
}

export function updateNote(
    db: Database,
    noteId: number,
    updates: UpdateNoteOptions,
    scope: NoteMutationScope,
): Note | null {
    const existing = getNoteById(db, noteId);
    if (!existing || !noteBelongsToScope(existing, scope)) {
        return null;
    }

    const now = Date.now();
    const sets: string[] = ["updated_at = ?"];
    const params: Array<string | number | null> = [now];

    if (updates.content !== undefined) {
        sets.push("content = ?");
        params.push(updates.content);
    }
    if (updates.sessionId !== undefined) {
        sets.push("session_id = ?");
        params.push(updates.sessionId);
    }
    const smartConditionChanged =
        existing.type === "smart" &&
        updates.surfaceCondition !== undefined &&
        updates.surfaceCondition !== existing.surfaceCondition;

    if (updates.status !== undefined && !smartConditionChanged) {
        sets.push("status = ?");
        params.push(updates.status);
    }

    if (existing.type === "smart") {
        if (updates.projectPath !== undefined) {
            sets.push("project_path = ?");
            params.push(updates.projectPath);
        }
        if (updates.surfaceCondition !== undefined) {
            sets.push("surface_condition = ?");
            params.push(updates.surfaceCondition);
        }
        if (smartConditionChanged) {
            // A new trigger has not been evaluated yet; clear stale readiness so
            // the note cannot keep surfacing under the previous condition.
            sets.push(
                "status = 'pending'",
                "last_checked_at = NULL",
                "ready_at = NULL",
                "ready_reason = NULL",
            );
            sets.push(
                "compiled_provider = ?",
                "compiled_config = ?",
                "compiled_at = ?",
                "compile_status = ?",
            );
            params.push(
                updates.compiledProvider ?? null,
                updates.compiledConfig ?? null,
                updates.compiledAt ?? null,
                updates.compileStatus ?? null,
            );
            if (noteCheckColumnsExist(db)) {
                sets.push(
                    "compiled_check = NULL",
                    "manifest_json = NULL",
                    "check_hash = NULL",
                    "check_cron = NULL",
                    "check_version = 0",
                    "check_status = 'uncompiled'",
                    "check_failure_count = 0",
                    "check_network_failure_count = 0",
                    "check_quarantined_until = NULL",
                    "check_next_due_at = NULL",
                    "check_compiled_at = NULL",
                    "check_false_since_at = NULL",
                    "check_last_liveness_at = NULL",
                );
            }
        } else {
            if (updates.lastCheckedAt !== undefined) {
                sets.push("last_checked_at = ?");
                params.push(updates.lastCheckedAt);
            }
            if (updates.readyAt !== undefined) {
                sets.push("ready_at = ?");
                params.push(updates.readyAt);
            }
            if (updates.readyReason !== undefined) {
                sets.push("ready_reason = ?");
                params.push(updates.readyReason);
            }
        }
    }

    if (sets.length === 1) {
        return null;
    }

    params.push(noteId);
    const result = db
        .prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
        .get(...params);
    return isNoteRow(result) ? toNote(result) : null;
}

export function dismissNote(db: Database, noteId: number, scope: NoteMutationScope): boolean {
    const existing = getNoteById(db, noteId);
    if (!existing || !noteBelongsToScope(existing, scope)) {
        return false;
    }

    const result = db
        .prepare(
            "UPDATE notes SET status = 'dismissed', updated_at = ? WHERE id = ? AND status != 'dismissed'",
        )
        .run(Date.now(), noteId);
    return result.changes > 0;
}

export function markNoteReady(db: Database, noteId: number, reason?: string): void {
    const now = Date.now();
    db.prepare(
        "UPDATE notes SET status = 'ready', ready_at = ?, ready_reason = ?, updated_at = ?, last_checked_at = ? WHERE id = ? AND type = 'smart'",
    ).run(now, reason ?? null, now, now, noteId);
}

export function markNoteChecked(db: Database, noteId: number): void {
    const now = Date.now();
    db.prepare(
        "UPDATE notes SET last_checked_at = ?, updated_at = ? WHERE id = ? AND type = 'smart'",
    ).run(now, now, noteId);
}

export function deleteNote(db: Database, noteId: number): boolean {
    const result = db.prepare("DELETE FROM notes WHERE id = ?").run(noteId);
    return result.changes > 0;
}

export function replaceAllSessionNotes(db: Database, sessionId: string, notes: string[]): void {
    const now = Date.now();
    db.transaction(() => {
        db.prepare("DELETE FROM notes WHERE session_id = ? AND type = 'session'").run(sessionId);
        const insert = db.prepare(
            "INSERT INTO notes (type, status, content, session_id, created_at, updated_at, harness) VALUES ('session', 'active', ?, ?, ?, ?, ?)",
        );
        for (const note of notes) {
            insert.run(note, sessionId, now, now, getHarness());
        }
    })();
}
