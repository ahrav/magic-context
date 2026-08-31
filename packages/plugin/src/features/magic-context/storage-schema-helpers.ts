import type { Database } from "../../shared/sqlite";

export function ensureColumn(
    db: Database,
    table: string,
    column: string,
    definition: string,
): void {
    if (
        !/^[a-z][a-z0-9_]*$/.test(table) ||
        !/^[a-z][a-z0-9_]*$/.test(column) ||
        !/^[A-Z0-9_"'(),[\]\s]+$/i.test(definition)
    ) {
        throw new Error(`Unsafe schema identifier: ${table}.${column} ${definition}`);
    }
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (rows.some((row) => row.name === column)) {
        return;
    }
    try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (err) {
        const recheck = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
        if (recheck.some((row) => row.name === column)) {
            return;
        }
        throw err;
    }
}
