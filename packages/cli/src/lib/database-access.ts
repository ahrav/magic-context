import {
    closeSync,
    copyFileSync,
    existsSync,
    mkdtempSync,
    openSync,
    readSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    ensureContextStoreUuid,
    getContextStoreUuid,
} from "@magic-context/core/features/magic-context/context-authority";
import {
    getPersistedSchemaVersion as getCorePersistedSchemaVersion,
    LATEST_SUPPORTED_VERSION,
} from "@magic-context/core/features/magic-context/storage-db";
import {
    classifyDatabaseFormatFamily,
    type DatabaseFormatFamily,
    type DatabaseResetMarker,
    type ExpectedDirectFormat,
    inspectDatabaseForClassification,
    listDatabaseFamilyArtifacts,
    MC_APPLICATION_ID,
    readDatabaseResetMarker,
} from "@magic-context/core/features/magic-context/storage-format-epoch";
import { computeExpectedDirectFormat } from "@magic-context/core/features/magic-context/test-database";
import type { Database as DatabaseType } from "@magic-context/core/shared/sqlite";
import { Database } from "@magic-context/core/shared/sqlite";

export function getPersistedSchemaVersion(db: DatabaseType): number {
    return getCorePersistedSchemaVersion(db);
}

export class UnsupportedSchemaVersionError extends Error {
    readonly path: string;
    readonly persistedVersion: number;
    readonly supportedVersion: number;

    constructor(path: string, persistedVersion: number, supportedVersion: number) {
        super(
            `Refusing to open ${path}: database schema v${persistedVersion} is newer than this CLI supports (max v${supportedVersion}). Update Magic Context before using this database.`,
        );
        this.name = "UnsupportedSchemaVersionError";
        this.path = path;
        this.persistedVersion = persistedVersion;
        this.supportedVersion = supportedVersion;
    }
}

export class OutdatedSchemaVersionError extends Error {
    readonly path: string;
    readonly persistedVersion: number;
    readonly minimumSupportedVersion: number;

    constructor(path: string, persistedVersion: number, minimumSupportedVersion: number) {
        super(
            `Refusing to mutate ${path}: database schema v${persistedVersion} is behind this CLI's schema floor v${minimumSupportedVersion}. Run a session or doctor migrate first so the plugin can upgrade it, then retry.`,
        );
        this.name = "OutdatedSchemaVersionError";
        this.path = path;
        this.persistedVersion = persistedVersion;
        this.minimumSupportedVersion = minimumSupportedVersion;
    }
}

/**
 * A CLI write must not make a live database newer than a running plugin can
 * read. The current checkout is therefore the mutation floor; read-only
 * diagnostics may still inspect older supported schemas without changing them.
 */
export const CLI_SCHEMA_FLOOR_VERSION = LATEST_SUPPORTED_VERSION;

function configureWriteConnection(db: DatabaseType): void {
    // Total claims-backfill lock budget: 25.9s = five 5s waits + 900ms backoff. commentlint: allow(JUDGE)
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    const row = db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
    if (Object.values(row)[0] !== 1) {
        db.close();
        throw new Error("SQLite foreign_keys could not be enabled for CLI mutation");
    }
}

/**
 * Opens an existing SQLite file without silently creating an empty replacement.
 * Callers must treat null as a graceful missing-database path.
 */
export function openExistingDatabase(
    path: string,
    options: { readonly: boolean },
): DatabaseType | null {
    if (!existsSync(path)) return null;
    if (options.readonly) {
        const db = new Database(path, { readonly: true });
        return db;
    }

    // Open read-write WITHOUT SQLITE_OPEN_CREATE, so the race where the file
    // disappears between the existence check and the constructor errors instead
    // of silently creating an empty database. The two backends need different
    // spellings: bun:sqlite's Linux build rejects file:// URIs ("unable to open
    // database file") but honors { create: false }, while node:sqlite has no
    // create option and needs the URI's mode=rw.
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
        // SAFETY: create/readwrite are bun:sqlite-only options, absent from the
        // shared better-sqlite3-shaped Options type the wrapper exports; the Bun
        // branch above guarantees the bun:sqlite constructor receives them.
        const db = new Database(path, { create: false, readwrite: true } as unknown as {
            readonly: boolean;
        });
        configureWriteConnection(db);
        return db;
    }
    const uri = pathToFileURL(path);
    uri.searchParams.set("mode", "rw");
    const db = new Database(uri.href);
    configureWriteConnection(db);
    return db;
}

/**
 * Applies the shared schema fence immediately after opening context.db. No query
 * or migration write may run until this check accepts the persisted version.
 */
export function openExistingContextDatabase(
    path: string,
    options: { readonly: boolean; minimumSupportedVersion?: number },
): DatabaseType | null {
    const db = openExistingDatabase(path, options);
    if (db === null) return null;

    try {
        const persistedVersion = getPersistedSchemaVersion(db);
        if (persistedVersion > LATEST_SUPPORTED_VERSION) {
            throw new UnsupportedSchemaVersionError(
                path,
                persistedVersion,
                LATEST_SUPPORTED_VERSION,
            );
        }
        const minimumSupportedVersion =
            options.minimumSupportedVersion ??
            (options.readonly ? undefined : CLI_SCHEMA_FLOOR_VERSION);
        if (minimumSupportedVersion !== undefined && persistedVersion < minimumSupportedVersion) {
            throw new OutdatedSchemaVersionError(path, persistedVersion, minimumSupportedVersion);
        }
        if (!options.readonly) {
            // The CLI has no module route during database open. It can mint the
            // local store identity, but REGRESSED detection remains a later
            // module-reconciliation step when the module becomes reachable.
            const hasIdentityTable = Boolean(
                db
                    .prepare(
                        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_store_meta'",
                    )
                    .get(),
            );
            if (hasIdentityTable && !getContextStoreUuid(db)) ensureContextStoreUuid(db);
        }
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}

/**
 * Opens a live context database for a CLI mutation without running schema
 * migrations. The plugin boot path owns schema upgrades; while the plugin is
 * running, it may enforce an older maximum schema version.
 */
export function openExistingContextDatabaseForMutation(path: string): DatabaseType | null {
    return openExistingContextDatabase(path, {
        readonly: false,
        minimumSupportedVersion: CLI_SCHEMA_FLOOR_VERSION,
    });
}

/** Create a consistent SQLite snapshot, including committed WAL contents. */
export async function backupDatabaseSnapshot(db: DatabaseType, destination: string): Promise<void> {
    const serializable = db as DatabaseType & { serialize?: () => Uint8Array };
    if (typeof serializable.serialize === "function") {
        writeFileSync(destination, serializable.serialize(), { flag: "wx" });
        return;
    }

    const moduleName = "node:" + "sqlite";
    const sqlite = (await import(moduleName)) as {
        backup?: (source: unknown, path: string) => Promise<void>;
    };
    if (typeof sqlite.backup !== "function") {
        throw new Error("The active SQLite runtime does not provide a snapshot backup API");
    }
    await sqlite.backup(db, destination);
}

// ---------------------------------------------------------------------------
// U11 direct-format family state (KTD11, R15): read-only CLI access that
// distinguishes current, pristine, unsupported, reset-pending, and corrupt
// direct-format state without initializing schema or mutating the family.
// ---------------------------------------------------------------------------

export type DirectDatabaseFamilyState =
    | { readonly state: "pristine" }
    | { readonly state: "current"; readonly databaseIncarnationId: string }
    | {
          readonly state: "reset-pending";
          /** Present marker, or the malformed-read reason recovery must refuse on. */
          readonly marker:
              | { readonly status: "present"; readonly marker: DatabaseResetMarker }
              | { readonly status: "malformed"; readonly reason: string };
      }
    | {
          readonly state: "unsupported";
          readonly family: DatabaseFormatFamily;
          readonly reasons: readonly string[];
          /** Incarnation when the family carries a readable direct-format marker. */
          readonly databaseIncarnationId: string | null;
      }
    | {
          readonly state: "corrupt";
          readonly format: "direct" | "unknown";
          readonly directFormatSignals: readonly string[];
          readonly detail: string;
      };

let cachedExpectedDirectFormat: ExpectedDirectFormat | null = null;

function getExpectedDirectFormat(): ExpectedDirectFormat {
    cachedExpectedDirectFormat ??= computeExpectedDirectFormat();
    return cachedExpectedDirectFormat;
}

function readDirectFormatHeaderSignals(dbPath: string): string[] {
    const header = Buffer.alloc(100);
    let fd: number | null = null;
    try {
        fd = openSync(dbPath, "r");
        if (readSync(fd, header, 0, header.length, 0) < header.length) return [];
    } catch {
        return [];
    } finally {
        if (fd !== null) closeSync(fd);
    }
    if (header.toString("ascii", 0, 16) !== "SQLite format 3\0") return [];
    const signals: string[] = [];
    const userVersion = header.readUInt32BE(60);
    const applicationId = header.readUInt32BE(68);
    if (applicationId === MC_APPLICATION_ID) {
        signals.push('application_id is the direct-format "MCTX" value');
    }
    if (userVersion !== 0)
        signals.push(`user_version ${userVersion} is direct-format epoch vocabulary`);
    return signals;
}

/**
 * Classify the on-disk database family for CLI diagnostics and reset. Never
 * initializes schema. Content is read from a private temp copy of the family
 * (main, WAL, SHM) because even a read-only SQLite open rewrites an existing
 * SHM file; artifact presence is still checked at the real path.
 */
export function inspectDirectDatabaseFamilyState(dbPath: string): DirectDatabaseFamilyState {
    const markerRead = readDatabaseResetMarker(dbPath);
    if (markerRead.status !== "absent") return { state: "reset-pending", marker: markerRead };
    if (!existsSync(dbPath)) {
        const artifacts = listDatabaseFamilyArtifacts(dbPath);
        if (artifacts.length === 0) return { state: "pristine" };
        return {
            state: "unsupported",
            family: "orphan-artifacts",
            reasons: artifacts.map(
                (artifact) => `orphan ${artifact} artifact without a current main database`,
            ),
            databaseIncarnationId: null,
        };
    }
    let probeDir: string | null = null;
    let db: DatabaseType | null = null;
    try {
        probeDir = mkdtempSync(join(tmpdir(), "mc-family-probe-"));
        const probePath = join(probeDir, basename(dbPath));
        for (const suffix of ["", "-wal", "-shm"]) {
            const source = `${dbPath}${suffix}`;
            if (existsSync(source)) copyFileSync(source, `${probePath}${suffix}`);
        }
        db = new Database(probePath, { readonly: true });
        // Content comes from the probe connection; existence and artifact
        // checks inside inspectDatabaseForClassification use the real path.
        const inspection = inspectDatabaseForClassification(db, dbPath);
        const classification = classifyDatabaseFormatFamily(inspection, getExpectedDirectFormat());
        const databaseIncarnationId =
            inspection.marker.status === "present"
                ? inspection.marker.marker.databaseIncarnationId
                : null;
        if (classification.family === "current" && databaseIncarnationId !== null) {
            return { state: "current", databaseIncarnationId };
        }
        if (classification.family === "pristine") return { state: "pristine" };
        return {
            state: "unsupported",
            family: classification.family,
            reasons: classification.reasons,
            databaseIncarnationId,
        };
    } catch (error) {
        const directFormatSignals = readDirectFormatHeaderSignals(dbPath);
        return {
            state: "corrupt",
            format: directFormatSignals.length > 0 ? "direct" : "unknown",
            directFormatSignals,
            detail: error instanceof Error ? error.message : String(error),
        };
    } finally {
        db?.close();
        if (probeDir !== null) rmSync(probeDir, { recursive: true, force: true });
    }
}
