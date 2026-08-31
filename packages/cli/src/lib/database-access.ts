import {
    closeSync,
    copyFileSync,
    existsSync,
    mkdtempSync,
    openSync,
    readSync,
    rmSync,
    statSync,
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
    classifyPreOpenFamily,
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

/**
 * A CLI write must not make a live database newer than a running plugin supports.
 * The current checkout is the mutation floor; read-only diagnostics may inspect older supported schemas without changing them.
 */
export const CLI_SCHEMA_FLOOR_VERSION = LATEST_SUPPORTED_VERSION;

function configureWriteConnection(db: DatabaseType): void {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    const row = db.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
    if (Object.values(row)[0] !== 1) {
        db.close();
        throw new Error("SQLite foreign_keys could not be enabled for CLI mutation");
    }
}

/**
 * openExistingDatabase opens an existing SQLite file without silently creating an empty replacement.
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

    // openExistingDatabase opens read-write without SQLITE_OPEN_CREATE so a file that disappears after existsSync causes a constructor error instead of creating an empty database.
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
        // SAFETY: The Bun branch is the only branch that passes bun:sqlite-only create and readwrite options.
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
 * openExistingContextDatabase applies the schema fence before any migration write.
 */
export function openExistingContextDatabase(
    path: string,
    options: { readonly: boolean },
): DatabaseType | null {
    if (!existsSync(path)) return null;
    if (!options.readonly) {
        // The pre-open classifier refuses unsupported artifact families before SQLite recovery.
        const preOpen = classifyPreOpenFamily(path, {
            artifacts: listDatabaseFamilyArtifacts(path),
            mainFileExists: true,
            mainFileSize: statSync(path).size,
        });
        if (preOpen.decision === "refuse") {
            throw new Error(
                `Refusing to mutate ${path}: database is not the exact supported direct format (${preOpen.family}): ${preOpen.reasons.join("; ")}. Run 'npx @cortexkit/magic-context@latest doctor reset-db' only if you intend to abandon it.`,
            );
        }
    }
    const db = openExistingDatabase(path, options);
    if (db === null) return null;

    try {
        if (!options.readonly) {
            const classification = classifyDatabaseFormatFamily(
                inspectDatabaseForClassification(db, path),
                getExpectedDirectFormat(),
            );
            if (classification.family !== "current") {
                throw new Error(
                    `Refusing to mutate ${path}: database is not the exact supported direct format (${classification.family}): ${classification.reasons.join("; ")}. Run 'npx @cortexkit/magic-context@latest doctor reset-db' only if you intend to abandon it.`,
                );
            }
        }
        const persistedVersion = getPersistedSchemaVersion(db);
        if (persistedVersion > LATEST_SUPPORTED_VERSION) {
            throw new UnsupportedSchemaVersionError(
                path,
                persistedVersion,
                LATEST_SUPPORTED_VERSION,
            );
        }
        if (!options.readonly) {
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
 */
export function openExistingContextDatabaseForMutation(path: string): DatabaseType | null {
    return openExistingContextDatabase(path, { readonly: false });
}

/* */
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
// ---------------------------------------------------------------------------

export type DirectDatabaseFamilyState =
    | { readonly state: "pristine" }
    | { readonly state: "current"; readonly databaseIncarnationId: string }
    | {
          readonly state: "reset-pending";
          /* */
          readonly marker:
              | { readonly status: "present"; readonly marker: DatabaseResetMarker }
              | { readonly status: "malformed"; readonly reason: string };
      }
    | {
          readonly state: "unsupported";
          readonly family: DatabaseFormatFamily;
          readonly reasons: readonly string[];
          /* */
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
    const expected = cachedExpectedDirectFormat ?? computeExpectedDirectFormat();
    cachedExpectedDirectFormat = expected;
    return expected;
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
 * The probe opens a throwaway family copy read-write so SQLite can roll back a hot journal.
 * The probe connection never opens the real database family.
 */
function openProbeCopyForRecovery(probePath: string): DatabaseType {
    if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
        // The wrapper's shared Options type does not include Bun's create and readwrite options.
        return new Database(probePath, { create: false, readwrite: true } as unknown as {
            readonly: boolean;
        });
    }
    return new Database(probePath);
}

/**
 * The diagnostic classifier classifies the on-disk database family for CLI diagnostics and reset.
 * initializes schema.
 *
 * The probe reads a private isolated copy of the main database, WAL, SHM, and rollback journal; artifact presence is checked at the real path.
 * The probe copies the main database, WAL, SHM, and rollback journal because a read-only SQLite open can rewrite an existing SHM file.
 *
 * A rollback journal can remain hot after an interrupted transaction.
 * A read-only connection cannot recover the copied hot journal, so opening it read-only would classify a recoverable family as corrupt.
 * Opening the probe copy lets SQLite recover a hot journal without modifying the real family.
 * `create: false` prevents a missing copy from opening as a fresh database and classifying as pristine.
 * pristine.
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
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            const source = `${dbPath}${suffix}`;
            if (existsSync(source)) copyFileSync(source, `${probePath}${suffix}`);
        }
        db = openProbeCopyForRecovery(probePath);
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
