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

/** Positive-safe-integer read of a schema-meta cursor; anything absent,
 * unparsable, or non-positive reads as 0 so cursor arithmetic restarts from
 * the beginning instead of propagating NaN or a corrupted value. */
export function readIntMeta(db: Database, key: string): number {
    const parsed = Number.parseInt(readSchemaMeta(db, key) ?? "0", 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
