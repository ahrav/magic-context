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
import {
    buildSchemaComponentManifest,
    CURRENT_SCHEMA_COMPONENTS,
    composeRegisteredSchema,
    computeSchemaManifestDigest,
    listSchemaObjectNames,
    type RegisteredSchemaComponent,
} from "./storage-current-schema.ts";
import {
    buildDirectFormatMarker,
    createDirectFormatMarkerSchema,
    DIRECT_FORMAT_EPOCH,
    type DirectFormatMarker,
    type ExpectedDirectFormat,
    MC_APPLICATION_ID,
    stampDirectFormatMarker,
} from "./storage-format-epoch.ts";

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

/**
 * Compute the expected direct format (registered inventory plus marker
 * objects) by composing the components into a scratch in-memory database, so
 * the expectation can never drift from what composition actually creates.
 */
export function computeExpectedDirectFormat(
    components: readonly RegisteredSchemaComponent[] = CURRENT_SCHEMA_COMPONENTS,
): ExpectedDirectFormat {
    const manifest = buildSchemaComponentManifest(components);
    const scratch = new Database(":memory:");
    try {
        scratch.exec("PRAGMA foreign_keys=ON");
        composeRegisteredSchema(scratch, components);
        createDirectFormatMarkerSchema(scratch);
        return {
            applicationId: MC_APPLICATION_ID,
            formatEpoch: DIRECT_FORMAT_EPOCH,
            componentManifestDigest: computeSchemaManifestDigest(manifest),
            schemaObjectNames: listSchemaObjectNames(scratch),
        };
    } finally {
        scratch.close();
    }
}

export function createDirectTestDatabase(
    options: DirectTestDatabaseOptions = {},
): DirectTestDatabase {
    const components = options.components ?? CURRENT_SCHEMA_COMPONENTS;
    const path = options.path ?? ":memory:";
    const db = new Database(path);
    try {
        db.exec("PRAGMA busy_timeout=5000");
        db.exec("PRAGMA foreign_keys=ON");
        // SQLite does not support WAL for in-memory databases.
        if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
        const marker = buildDirectFormatMarker({
            componentManifestDigest: computeSchemaManifestDigest(
                buildSchemaComponentManifest(components),
            ),
            createdAtMs: options.nowMs ?? Date.now(),
            ...(options.databaseIncarnationId === undefined
                ? {}
                : { databaseIncarnationId: options.databaseIncarnationId }),
        });
        db.transaction(() => {
            composeRegisteredSchema(db, components);
            createDirectFormatMarkerSchema(db);
            stampDirectFormatMarker(db, marker);
        }).immediate();
        return { db, marker };
    } catch (error) {
        db.close();
        throw error;
    }
}
