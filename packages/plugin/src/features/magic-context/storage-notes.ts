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
    /** `anchorOrdinal` records the live-tail message ordinal when the note is written.
     * The agent uses `anchorOrdinal` to trace the note to its source conversation.
     * `anchorOrdinal` is null when the session has no indexed messages. */
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
    sourceRevision: number;
    stateVersion: number;
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
    source_revision?: number | null;
    state_version?: number | null;
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
        sourceRevision: toNullableNumber(row.source_revision) ?? 0,
        stateVersion: toNullableNumber(row.state_version) ?? 0,
    };
}

function noteColumnExists(db: Database, column: string): boolean {
    try {
        const rows = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name?: string }>;
        return rows.some((row) => row.name === column);
    } catch {
        return false;
    }
}

function noteCheckColumnsExist(db: Database): boolean {
    return noteColumnExists(db, "compiled_check");
}

function noteRevisionColumnsExist(db: Database): boolean {
    return noteColumnExists(db, "state_version");
}

/**
 * This SQL fragment increments the optimistic-concurrency revision counter.
 * Every smart-note mutator must include the revision bump.
 * Skipping the bump defeats the claim revision fence.
 * `smart-notes/storage.ts` (`claimExpectedState`).
 */
function revisionBumpSql(db: Database): string {
    return noteRevisionColumnsExist(db) ? ", state_version = state_version + 1" : "";
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

/**
 * Callers must bind `searchableNoteScopeParams` after all preceding statement placeholders.
 * Callers must bind `searchableNoteScopeParams` after all preceding statement placeholders.
 */
function searchableNoteScopeSql(prefix: string): string {
    const col = (name: string) => (prefix.length > 0 ? `${prefix}.${name}` : name);
    const statusPlaceholders = NOTE_SEARCH_STATUSES.map(() => "?").join(", ");
    return `${col("status")} IN (${statusPlaceholders})
                    AND ((${col("type")} = 'session' AND ${col("session_id")} = ?)
                      OR (${col("type")} = 'smart' AND ${col("project_path")} = ?))`;
}

function searchableNoteScopeParams(scope: {
    sessionId: string;
    projectPath: string;
}): Array<string | number> {
    return [...NOTE_SEARCH_STATUSES, scope.sessionId, scope.projectPath];
}

function notesProjectionExists(db: Database): boolean {
    const row = db
        .prepare(
            "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'notes_fts' LIMIT 1",
        )
        .get() as { present?: number } | null;
    return row?.present === 1;
}

/** Scope and status must precede LIMIT so ineligible rows cannot crowd eligible hits out of the capped pool.
 * Scope and status must precede LIMIT so ineligible rows cannot crowd eligible hits out of the capped pool. */
export function selectNoteCandidateIds(
    db: Database,
    ftsQuery: string,
    scope: { sessionId: string; projectPath: string; limit: number },
): number[] | null {
    if (!notesProjectionExists(db)) return null;
    if (ftsQuery.length === 0) return [];
    try {
        const rows = db
            .prepare(
                `SELECT notes.id AS id
                   FROM notes_fts
                   JOIN notes ON notes.id = notes_fts.rowid
                  WHERE notes_fts MATCH ?
                    AND ${searchableNoteScopeSql("notes")}
                  ORDER BY bm25(notes_fts), notes.id ASC
                  LIMIT ?`,
            )
            .all(ftsQuery, ...searchableNoteScopeParams(scope), scope.limit) as Array<{
            id?: number;
        }>;
        return rows
            .map((row) => row.id)
            .filter((id): id is number => typeof id === "number" && Number.isFinite(id));
    } catch {
        return null;
    }
}

/**
 * The query returns document frequencies in FTS-query order for the scoped searchable corpus.
 * The query returns null when the projection is absent or an FTS query is malformed.
 * Counts cover the whole scoped corpus, not the capped candidate pool, so probe-discrimination weights use matching corpus-wide numerators and denominators.
 * Counts cover the whole scoped corpus, not the capped candidate pool, so probe-discrimination weights use matching corpus-wide numerators and denominators.
 */
export function countNoteFtsMatchesBatch(
    db: Database,
    ftsQueries: readonly string[],
    scope: { sessionId: string; projectPath: string },
): number[] | null {
    if (!notesProjectionExists(db)) return null;
    if (ftsQueries.length === 0) return [];
    const branch = `SELECT COUNT(*) AS count
               FROM notes_fts
               JOIN notes ON notes.id = notes_fts.rowid
              WHERE notes_fts MATCH ?
                AND ${searchableNoteScopeSql("notes")}`;
    try {
        const rows = db
            .prepare(
                ftsQueries
                    .map((_, index) => `SELECT ${index} AS queryIndex, count FROM (${branch})`)
                    .join("\nUNION ALL\n"),
            )
            .all(
                ...ftsQueries.flatMap((query) => [query, ...searchableNoteScopeParams(scope)]),
            ) as Array<{ queryIndex?: number; count?: number }>;
        const counts = ftsQueries.map(() => 0);
        for (const row of rows) {
            if (
                typeof row.queryIndex === "number" &&
                row.queryIndex >= 0 &&
                row.queryIndex < counts.length &&
                typeof row.count === "number"
            ) {
                counts[row.queryIndex] = row.count;
            }
        }
        return counts;
    } catch {
        return null;
    }
}

/** The query returns only `ids` within the caller's search scope, in scoped-scan order.
 * */
export function getSearchableNotesByIds(
    db: Database,
    options: { ids: readonly number[]; sessionId: string; projectPath: string },
): Note[] {
    if (options.ids.length === 0) return [];
    return (
        db
            .prepare(
                `SELECT notes.* FROM json_each(?) AS requested
                  CROSS JOIN notes ON notes.id = requested.value
                  WHERE ${searchableNoteScopeSql("notes")}
                  ORDER BY notes.created_at ASC, notes.id ASC`,
            )
            .all(
                JSON.stringify([...options.ids]),
                ...searchableNoteScopeParams(options),
            ) as unknown[]
    )
        .filter(isNoteRow)
        .map(toNote);
}

export function getRecentSearchableNotes(
    db: Database,
    options: { sessionId: string; projectPath: string; limit: number },
): Note[] {
    return (
        db
            .prepare(
                `SELECT * FROM notes
                  WHERE ${searchableNoteScopeSql("")}
                  ORDER BY created_at DESC, id DESC
                  LIMIT ?`,
            )
            .all(...searchableNoteScopeParams(options), options.limit) as unknown[]
    )
        .filter(isNoteRow)
        .map(toNote);
}

/* */
export function countSearchableNotes(
    db: Database,
    options: { sessionId: string; projectPath: string },
): number {
    const row = db
        .prepare(
            `SELECT (SELECT COUNT(*) FROM notes
                      WHERE ${searchableNoteScopeSql("")}) AS count`,
        )
        .get(...searchableNoteScopeParams(options)) as { count?: number } | null;
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
    // Changing projectPath invalidates the compiled artifact.
    const compilerInputChanged =
        existing.type === "smart" &&
        (smartConditionChanged ||
            (updates.content !== undefined && updates.content !== existing.content) ||
            (updates.projectPath !== undefined && updates.projectPath !== existing.projectPath));

    // The mutator rejects an explicit status when a compiler-input edit forces `status = 'pending'`; callers must update status separately.
    // The mutator rejects an explicit status when a compiler-input edit forces `status = 'pending'`; callers must update status separately.
    // The mutator rejects an explicit status when a compiler-input edit forces `status = 'pending'`; callers must update status separately.
    if (updates.status !== undefined && compilerInputChanged && updates.status !== "pending") {
        throw new Error(
            `updateNote: cannot combine status '${updates.status}' with a smart-note compiler-input edit (content/condition/projectPath force status='pending')`,
        );
    }
    if (updates.status !== undefined && !compilerInputChanged) {
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
        if (compilerInputChanged) {
            // The trigger clears stale readiness until the updated condition is evaluated.
            // A project move preserves `surfaceCondition` but invalidates the compiled artifact.
            sets.push(
                "status = 'pending'",
                "last_checked_at = NULL",
                "ready_at = NULL",
                "ready_reason = NULL",
            );
            if (smartConditionChanged) {
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
            } else if (
                updates.projectPath !== undefined &&
                updates.projectPath !== existing.projectPath &&
                existing.compileStatus === "compiled"
            ) {
                // A project move preserves `surfaceCondition` but invalidates the compiled artifact.
                sets.push(
                    "compiled_provider = NULL",
                    "compiled_config = NULL",
                    "compiled_at = NULL",
                    "compile_status = NULL",
                );
            }
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

    if (existing.type === "smart" && noteRevisionColumnsExist(db)) {
        sets.push("state_version = state_version + 1");
        if (compilerInputChanged) {
            sets.push("source_revision = source_revision + 1");
        }
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

    const revisionBump = revisionBumpSql(db);
    const result = db
        .prepare(
            `UPDATE notes SET status = 'dismissed', updated_at = ?${revisionBump} WHERE id = ? AND status != 'dismissed'`,
        )
        .run(Date.now(), noteId);
    return result.changes > 0;
}

export function markNoteReady(db: Database, noteId: number, reason?: string): void {
    const now = Date.now();
    const revisionBump = revisionBumpSql(db);
    db.prepare(
        `UPDATE notes SET status = 'ready', ready_at = ?, ready_reason = ?, updated_at = ?, last_checked_at = ?${revisionBump} WHERE id = ? AND type = 'smart'`,
    ).run(now, reason ?? null, now, now, noteId);
}

export function markNoteChecked(db: Database, noteId: number): void {
    const now = Date.now();
    const revisionBump = revisionBumpSql(db);
    db.prepare(
        `UPDATE notes SET last_checked_at = ?, updated_at = ?${revisionBump} WHERE id = ? AND type = 'smart'`,
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
