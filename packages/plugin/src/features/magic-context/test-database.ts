/**
 * are untouched.
 *
 */

import { Database } from "../../shared/sqlite.ts";
import {
    buildSchemaComponentManifest,
    CURRENT_SCHEMA_COMPONENTS,
    composeRegisteredSchema,
    computeSchemaManifestDigest,
    type RegisteredSchemaComponent,
} from "./storage-current-schema.ts";
import {
    buildDirectFormatMarker,
    createDirectFormatMarkerSchema,
    type DirectFormatMarker,
    stampDirectFormatMarker,
} from "./storage-format-epoch.ts";

export { computeExpectedDirectFormat } from "./storage-current-schema.ts";

export interface DirectTestDatabaseOptions {
    /* */
    readonly path?: string;
    readonly components?: readonly RegisteredSchemaComponent[];
    readonly nowMs?: number;
    /** `databaseIncarnationId` makes incarnation IDs deterministic in tests. */
    readonly databaseIncarnationId?: string;
}

export interface DirectTestDatabase {
    readonly db: Database;
    readonly marker: DirectFormatMarker;
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
