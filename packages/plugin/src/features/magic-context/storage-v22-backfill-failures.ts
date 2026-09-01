import type { Database } from "../../shared/sqlite";

export type V22BackfillErrorClass =
    | "not_git_repo"
    | "git_missing"
    | "git_timeout"
    | "permission_denied"
    | "unknown";

type RecordableV22BackfillErrorClass = V22BackfillErrorClass | "dubious_ownership";

const ERROR_CLASSES = new Set<string>([
    "not_git_repo",
    "git_missing",
    "git_timeout",
    "permission_denied",
    "unknown",
]);

export interface V22BackfillFailureRow {
    id: number;
    tableName: string;
    rowId: number;
    rawProjectPath: string;
    errorClass: V22BackfillErrorClass;
    errorMessage: string | null;
    failedAt: number;
}

interface V22BackfillFailureDbRow {
    id: number;
    table_name: string;
    row_id: number;
    raw_project_path: string;
    error_class: V22BackfillErrorClass;
    error_message: string | null;
    failed_at: number;
}

function normalizeErrorClass(errorClass: RecordableV22BackfillErrorClass): V22BackfillErrorClass {
    if (errorClass === "dubious_ownership") {
        return "unknown";
    }
    if (!ERROR_CLASSES.has(errorClass)) {
        throw new Error(`Invalid v22 backfill error class: ${errorClass}`);
    }
    return errorClass;
}

function toV22BackfillFailure(row: V22BackfillFailureDbRow): V22BackfillFailureRow {
    return {
        id: row.id,
        tableName: row.table_name,
        rowId: row.row_id,
        rawProjectPath: row.raw_project_path,
        errorClass: row.error_class,
        errorMessage: row.error_message,
        failedAt: row.failed_at,
    };
}

export function recordV22BackfillFailure(
    db: Database,
    input: {
        tableName: string;
        rowId: number;
        rawProjectPath: string;
        errorClass: RecordableV22BackfillErrorClass;
        errorMessage?: string | null;
        failedAt?: number;
    },
): V22BackfillFailureRow {
    const errorClass = normalizeErrorClass(input.errorClass);
    db.prepare(
        `INSERT INTO v22_backfill_failures
            (table_name, row_id, raw_project_path, error_class, error_message, failed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(table_name, row_id) DO UPDATE SET
            raw_project_path = excluded.raw_project_path,
            error_class = excluded.error_class,
            error_message = excluded.error_message,
            failed_at = excluded.failed_at`,
    ).run(
        input.tableName,
        input.rowId,
        input.rawProjectPath,
        errorClass,
        input.errorMessage ?? null,
        input.failedAt ?? Date.now(),
    );
    const row = getV22BackfillFailure(db, input.tableName, input.rowId);
    if (!row) {
        throw new Error(
            `Failed to record v22 backfill failure for ${input.tableName}:${input.rowId}`,
        );
    }
    return row;
}

export function getV22BackfillFailure(
    db: Database,
    tableName: string,
    rowId: number,
): V22BackfillFailureRow | null {
    const row = db
        .prepare(
            `SELECT id, table_name, row_id, raw_project_path, error_class, error_message, failed_at
             FROM v22_backfill_failures
             WHERE table_name = ? AND row_id = ?`,
        )
        .get(tableName, rowId) as V22BackfillFailureDbRow | undefined;
    return row ? toV22BackfillFailure(row) : null;
}

export function listV22BackfillFailures(db: Database): V22BackfillFailureRow[] {
    const rows = db
        .prepare(
            `SELECT id, table_name, row_id, raw_project_path, error_class, error_message, failed_at
             FROM v22_backfill_failures
             ORDER BY id ASC`,
        )
        .all() as V22BackfillFailureDbRow[];
    return rows.map(toV22BackfillFailure);
}

export function deleteV22BackfillFailure(db: Database, tableName: string, rowId: number): boolean {
    const result = db
        .prepare("DELETE FROM v22_backfill_failures WHERE table_name = ? AND row_id = ?")
        .run(tableName, rowId) as { changes?: number };
    return (result.changes ?? 0) > 0;
}

export function clearV22BackfillFailures(db: Database): number {
    const result = db.prepare("DELETE FROM v22_backfill_failures").run() as { changes?: number };
    return result.changes ?? 0;
}
