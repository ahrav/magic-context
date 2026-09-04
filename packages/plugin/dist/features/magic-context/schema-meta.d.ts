import type { Database } from "../../shared/sqlite";
/** Read one `schema_migrations_meta` value; `null` when the key is absent. */
export declare function readSchemaMeta(db: Database, key: string): string | null;
/** Upsert one `schema_migrations_meta` value inside the caller's transaction. */
export declare function writeSchemaMeta(db: Database, key: string, value: string): void;
/** Positive-safe-integer read of a schema-meta cursor; anything absent,
 * unparsable, or non-positive reads as 0 so cursor arithmetic restarts from
 * the beginning instead of propagating NaN or a corrupted value. */
export declare function readIntMeta(db: Database, key: string): number;
//# sourceMappingURL=schema-meta.d.ts.map