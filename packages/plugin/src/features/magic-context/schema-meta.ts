import type { Database } from "../../shared/sqlite";

/** Read one `schema_migrations_meta` value; `null` when the key is absent. */
export function readSchemaMeta(db: Database, key: string): string | null {
    const row = db.prepare("SELECT value FROM schema_migrations_meta WHERE key = ?").get(key) as
        | { value: string }
        | null
        | undefined;
    return row?.value ?? null;
}

/** Upsert one `schema_migrations_meta` value inside the caller's transaction. */
export function writeSchemaMeta(db: Database, key: string, value: string): void {
    db.prepare(
        `INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
}
