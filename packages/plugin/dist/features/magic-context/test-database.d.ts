/**
 * Direct test-database factory: creates the exact current direct-format
 * schema from registered components — never through `initializeDatabase()`
 * or the legacy migration chain — and stamps the direct-format marker with a
 * fresh random database incarnation. New tests point here; existing tests
 * are untouched.
 *
 * Runtime imports use explicit `.ts` extensions so the Node smoke scripts
 * can load this module under Node's type-stripping loader.
 */
import { Database } from "../../shared/sqlite.ts";
import { type RegisteredSchemaComponent } from "./storage-current-schema.ts";
import { type DirectFormatMarker } from "./storage-format-epoch.ts";
export { computeExpectedDirectFormat } from "./storage-current-schema.ts";
export interface DirectTestDatabaseOptions {
    /** Defaults to ":memory:". */
    readonly path?: string;
    readonly components?: readonly RegisteredSchemaComponent[];
    readonly nowMs?: number;
    /** Injectable for deterministic incarnation IDs in tests. */
    readonly databaseIncarnationId?: string;
}
export interface DirectTestDatabase {
    readonly db: Database;
    readonly marker: DirectFormatMarker;
}
export declare function createDirectTestDatabase(options?: DirectTestDatabaseOptions): DirectTestDatabase;
//# sourceMappingURL=test-database.d.ts.map