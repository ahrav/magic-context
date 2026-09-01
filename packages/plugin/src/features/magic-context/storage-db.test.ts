/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
    type chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database, evaluateSqliteRuntimeGate } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    __resetStoragePrivatePermissionEnforcementForTests,
    setStoragePrivatePermissionEnforcement,
} from "../../shared/storage-permissions";
import { DIRECT_FORMAT_FENCE_MIGRATION_VERSION, FORK_MIGRATION_VERSION_FLOOR } from "./migrations";
import {
    __resetSchemaFenceStateForTests,
    __resetStoragePermissionFsForTests,
    __setStoragePermissionFsForTests,
    assertSqliteConnectionContract,
    closeDatabase,
    getFormatRefusal,
    getPersistedSchemaVersion,
    getSchemaFenceRejection,
    isDatabasePersisted,
    LATEST_SUPPORTED_VERSION,
    openDatabase,
    probeSqliteRuntimeGate,
    resolveDatabasePath,
} from "./storage-db";
import {
    buildDirectFormatMarker,
    computeMarkerDigest,
    MC_APPLICATION_ID,
    readDirectFormatMarker,
} from "./storage-format-epoch";
import { clearSession } from "./storage-meta-session";
import { createDirectTestDatabase } from "./test-database";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function makeTempDir(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
}

function useTempDataHome(prefix: string): string {
    const dataHome = makeTempDir(prefix);
    process.env.XDG_DATA_HOME = dataHome;
    return dataHome;
}

function resolveDbPath(dataHome: string): string {
    return join(dataHome, "cortexkit", "magic-context", "context.db");
}

function readPersistedVersion(dbPath: string): number {
    const db = new Database(dbPath);
    try {
        return getPersistedSchemaVersion(db);
    } finally {
        closeQuietly(db);
    }
}

function fileDigest(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function seedDirectDatabase(dir: string): string {
    const dbPath = join(dir, "context.db");
    const { db } = createDirectTestDatabase({ path: dbPath });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA journal_mode=DELETE");
    db.close();
    return dbPath;
}

afterEach(() => {
    closeDatabase();
    __resetSchemaFenceStateForTests();
    __resetStoragePermissionFsForTests();
    __resetStoragePrivatePermissionEnforcementForTests();
    process.env.XDG_DATA_HOME = originalXdgDataHome;

    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            // The cleanup ignores deletion failures, including Windows EBUSY.
        }
    }
    tempDirs.length = 0;
});

describe("upstream migration version lane", () => {
    it("reports zero when the migrations table is absent", () => {
        const db = new Database(":memory:");
        try {
            expect(getPersistedSchemaVersion(db)).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    it("reports zero for an empty migrations table", () => {
        const db = new Database(":memory:");
        try {
            db.exec(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL)",
            );
            expect(getPersistedSchemaVersion(db)).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    it("counts the direct-format fence row but ignores the reserved downstream floor and above", () => {
        const db = new Database(":memory:");
        try {
            db.exec(
                "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL)",
            );
            const insert = db.prepare(
                "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, 0)",
            );
            insert.run(DIRECT_FORMAT_FENCE_MIGRATION_VERSION, "fence");
            insert.run(FORK_MIGRATION_VERSION_FLOOR, "fork floor");
            insert.run(FORK_MIGRATION_VERSION_FLOOR + 5, "fork later");
            expect(getPersistedSchemaVersion(db)).toBe(DIRECT_FORMAT_FENCE_MIGRATION_VERSION);
        } finally {
            closeQuietly(db);
        }
    });
});

describe("storage-db direct format", () => {
    describe("#given openDatabase on a pristine family", () => {
        it("#when called first time #then bootstraps the exact current direct format", () => {
            const dataHome = useTempDataHome("storage-db-bootstrap-");

            const db = openDatabase();

            const dbPath = resolveDbPath(dataHome);
            expect(existsSync(dbPath)).toBe(true);
            expect(isDatabasePersisted(db)).toBe(true);
            const marker = readDirectFormatMarker(db);
            expect(marker.status).toBe("present");
            const applicationId = Object.values(
                db.prepare("PRAGMA application_id").get() as Record<string, unknown>,
            )[0];
            expect(Number(applicationId)).toBe(MC_APPLICATION_ID);
            expect(getPersistedSchemaVersion(db)).toBe(DIRECT_FORMAT_FENCE_MIGRATION_VERSION);
            expect(getFormatRefusal()).toBeNull();
            expect(getSchemaFenceRejection()).toBeNull();
        });

        it("#when called first time #then creates DB with WAL mode and busy_timeout", () => {
            const dataHome = useTempDataHome("storage-db-wal-");

            const db = openDatabase();

            const wal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
            const timeout = db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
            expect(wal.journal_mode.toLowerCase()).toBe("wal");
            expect(Object.values(timeout)[0]).toBe(5000);
            expect(existsSync(resolveDbPath(dataHome))).toBe(true);
        });

        it("#when reopened #then the database incarnation is stable", () => {
            useTempDataHome("storage-db-incarnation-");

            const first = openDatabase();
            const firstMarker = readDirectFormatMarker(first as Database);
            if (firstMarker.status !== "present") throw new Error("marker missing after open");
            closeDatabase();

            const second = openDatabase();
            const secondMarker = readDirectFormatMarker(second as Database);
            if (secondMarker.status !== "present") throw new Error("marker missing after reopen");
            expect(secondMarker.marker.databaseIncarnationId).toBe(
                firstMarker.marker.databaseIncarnationId,
            );
        });

        it("#when two processes bootstrap one pristine family #then both converge on one incarnation (AE1)", async () => {
            const dir = makeTempDir("storage-db-concurrent-bootstrap-");
            const dbPath = join(dir, "context.db");
            const workerPath = join(dir, "bootstrap-worker.ts");
            const storageDbModule = join(import.meta.dir, "storage-db.ts");
            writeFileSync(
                workerPath,
                [
                    `const { openDatabase } = await import(${JSON.stringify(storageDbModule)});`,
                    `const db = openDatabase(${JSON.stringify(dbPath)});`,
                    `if (!db) { console.error("refused"); process.exit(2); }`,
                    `const row = db.prepare("SELECT database_incarnation_id AS id FROM mc_format_marker").get();`,
                    `console.log(row.id);`,
                    `process.exit(0);`,
                ].join("\n"),
            );
            const spawnWorker = () =>
                Bun.spawn(["bun", workerPath], {
                    stdout: "pipe",
                    stderr: "pipe",
                    env: { ...process.env, NODE_ENV: "test" },
                });
            const workers = [spawnWorker(), spawnWorker()];
            const outputs = await Promise.all(
                workers.map(async (proc) => ({
                    exitCode: await proc.exited,
                    stdout: (await new Response(proc.stdout).text()).trim(),
                    stderr: (await new Response(proc.stderr).text()).trim(),
                })),
            );
            for (const output of outputs) {
                expect(output.exitCode, output.stderr).toBe(0);
                expect(output.stdout).toMatch(/^[0-9a-f]{32}$/);
            }
            expect(outputs[0].stdout).toBe(outputs[1].stdout);
        });
    });

    describe("#given openDatabase on an unsupported family", () => {
        it("#when a reset marker is pending #then refuses without changing the family", () => {
            const dir = makeTempDir("storage-db-reset-pending-");
            const dbPath = seedDirectDatabase(dir);
            writeFileSync(`${dbPath}.mc-reset`, "pending marker");
            const beforeMain = fileDigest(dbPath);

            expect(openDatabase(dbPath)).toBeNull();
            const refusal = getFormatRefusal();
            expect(refusal).not.toBeNull();
            expect(refusal?.reasons.join("; ")).toContain("reset marker");
            expect(fileDigest(dbPath)).toBe(beforeMain);
        });

        it("#when only an orphan sidecar exists #then refuses pristine bootstrap unchanged", () => {
            const dir = makeTempDir("storage-db-orphan-sidecar-");
            const dbPath = join(dir, "context.db");
            writeFileSync(`${dbPath}-wal`, "orphan wal");
            const before = readFileSync(`${dbPath}-wal`);

            expect(openDatabase(dbPath)).toBeNull();
            expect(getFormatRefusal()?.family).toBe("orphan-artifacts");
            expect(readFileSync(`${dbPath}-wal`)).toEqual(before);
        });

        it("#when a nonempty main has a pre-existing rollback journal #then refuses before SQLite recovery", () => {
            const dir = makeTempDir("storage-db-hot-journal-refusal-");
            const dbPath = join(dir, "context.db");
            const db = new Database(dbPath);
            db.exec("CREATE TABLE legacy_state (id INTEGER PRIMARY KEY, value TEXT)");
            db.close();
            const journalPath = `${dbPath}-journal`;
            writeFileSync(journalPath, "pre-existing rollback journal");
            const beforeMain = fileDigest(dbPath);
            const beforeJournal = fileDigest(journalPath);

            expect(openDatabase(dbPath)).toBeNull();
            expect(getFormatRefusal()?.family).toBe("unsupported");
            expect(fileDigest(dbPath)).toBe(beforeMain);
            expect(fileDigest(journalPath)).toBe(beforeJournal);
        });

        it("#when a journal sits beside an empty main #then bootstraps instead of refusing (AE1)", () => {
            const dir = makeTempDir("storage-db-bootstrap-journal-");
            const dbPath = join(dir, "context.db");
            writeFileSync(dbPath, "");
            writeFileSync(`${dbPath}-journal`, "interrupted bootstrap journal");

            const db = openDatabase(dbPath);

            expect(getFormatRefusal()).toBeNull();
            expect(db).not.toBeNull();
            expect(readDirectFormatMarker(db as Database).status).toBe("present");
        });

        it("#when a bootstrap is killed mid-transaction #then the next open recovers the family", async () => {
            const dir = makeTempDir("storage-db-bootstrap-crash-");
            const dbPath = join(dir, "context.db");
            const workerPath = join(dir, "wedge-worker.ts");
            // The child process holds `BEGIN IMMEDIATE` with the bootstrap shape, then exits without committing so the hot journal survives.
            // The child process exits without committing so the hot journal survives.
            writeFileSync(
                workerPath,
                [
                    `const { Database } = await import(${JSON.stringify(join(import.meta.dir, "../../shared/sqlite.ts"))});`,
                    `const db = new Database(${JSON.stringify(dbPath)});`,
                    `db.exec("PRAGMA journal_mode=DELETE");`,
                    `db.exec("BEGIN IMMEDIATE");`,
                    `db.exec("CREATE TABLE partial_bootstrap (id INTEGER PRIMARY KEY)");`,
                    `console.log("HELD");`,
                    `setInterval(() => {}, 1000);`,
                ].join("\n"),
            );
            const worker = Bun.spawn(["bun", workerPath], { stdout: "pipe", stderr: "pipe" });
            const reader = worker.stdout.getReader();
            await reader.read();
            reader.releaseLock();
            worker.kill("SIGKILL");
            await worker.exited;
            expect(statSync(dbPath).size).toBe(0);

            const db = openDatabase(dbPath);

            expect(getFormatRefusal()).toBeNull();
            expect(db).not.toBeNull();
            expect(readDirectFormatMarker(db as Database).status).toBe("present");
        });

        it("#when only the marker epoch is newer #then reports a fence rejection, not a reset-worthy refusal", () => {
            // The marker epoch alone determines migration direction.
            // Treating a newer marker epoch as a plain refusal would tell the operator to reset a family a newer binary owns.
            const dir = makeTempDir("storage-db-newer-epoch-only-");
            const dbPath = join(dir, "context.db");
            const future = new Database(dbPath);
            const futureMarker = buildDirectFormatMarker({
                componentManifestDigest: "b".repeat(64),
                createdAtMs: 1,
                formatEpoch: 2,
            });
            future.exec(`
                CREATE TABLE mc_format_marker (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    format_epoch INTEGER NOT NULL,
                    database_incarnation_id TEXT NOT NULL,
                    component_manifest_digest TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    marker_digest TEXT NOT NULL
                );
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
            `);
            future
                .prepare(
                    "INSERT INTO mc_format_marker (id, format_epoch, database_incarnation_id, component_manifest_digest, created_at_ms, marker_digest) VALUES (1, ?, ?, ?, ?, ?)",
                )
                .run(
                    futureMarker.formatEpoch,
                    futureMarker.databaseIncarnationId,
                    futureMarker.componentManifestDigest,
                    futureMarker.createdAtMs,
                    computeMarkerDigest(futureMarker),
                );
            // Fence row stays exactly at this build's supported version.
            future
                .prepare(
                    "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, 'same fence', 0)",
                )
                .run(LATEST_SUPPORTED_VERSION);
            future.close();
            const before = fileDigest(dbPath);

            expect(openDatabase(dbPath)).toBeNull();
            expect(getSchemaFenceRejection()).not.toBeNull();
            expect(getFormatRefusal()).toBeNull();
            expect(fileDigest(dbPath)).toBe(before);
        });

        it("#when the database is a legacy migration-lane family #then refuses it unchanged", () => {
            const dir = makeTempDir("storage-db-legacy-refusal-");
            const dbPath = join(dir, "context.db");
            const legacy = new Database(dbPath);
            legacy.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (86, 'legacy head', 0);
            `);
            legacy.close();
            const before = fileDigest(dbPath);

            expect(openDatabase(dbPath)).toBeNull();
            const refusal = getFormatRefusal();
            expect(refusal?.family).toBe("unsupported");
            expect(refusal?.reasons.join("; ")).toContain("direct-format marker is absent");
            expect(getSchemaFenceRejection()).toBeNull();
            expect(fileDigest(dbPath)).toBe(before);
            expect(existsSync(`${dbPath}-wal`)).toBe(false);
        });

        it("#when an unsupported family has committed WAL state #then refuses without checkpointing or truncating it", () => {
            const dir = makeTempDir("storage-db-legacy-wal-refusal-");
            const dbPath = join(dir, "context.db");
            const legacy = new Database(dbPath);
            legacy.exec(`
                PRAGMA journal_mode=WAL;
                PRAGMA wal_autocheckpoint=0;
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (86, 'legacy head', 0);
                INSERT INTO memories (content) VALUES ('committed only in the WAL');
            `);
            const walPath = `${dbPath}-wal`;
            expect(existsSync(walPath)).toBe(true);
            const beforeMain = fileDigest(dbPath);
            const beforeWal = fileDigest(walPath);

            try {
                expect(openDatabase(dbPath)).toBeNull();
                expect(getFormatRefusal()?.family).toBe("unsupported");
                expect(fileDigest(dbPath)).toBe(beforeMain);
                expect(fileDigest(walPath)).toBe(beforeWal);
            } finally {
                legacy.close();
            }
        });

        it("#when the database carries a newer format fence #then reports a schema-fence rejection", () => {
            const dir = makeTempDir("storage-db-newer-format-");
            const dbPath = join(dir, "context.db");
            const future = new Database(dbPath);
            const futureMarker = buildDirectFormatMarker({
                componentManifestDigest: "a".repeat(64),
                createdAtMs: 1,
                formatEpoch: 2,
            });
            future.exec(`
                CREATE TABLE mc_format_marker (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    format_epoch INTEGER NOT NULL,
                    database_incarnation_id TEXT NOT NULL,
                    component_manifest_digest TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    marker_digest TEXT NOT NULL
                );
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
            `);
            future
                .prepare(
                    "INSERT INTO mc_format_marker (id, format_epoch, database_incarnation_id, component_manifest_digest, created_at_ms, marker_digest) VALUES (1, ?, ?, ?, ?, ?)",
                )
                .run(
                    futureMarker.formatEpoch,
                    futureMarker.databaseIncarnationId,
                    futureMarker.componentManifestDigest,
                    futureMarker.createdAtMs,
                    computeMarkerDigest(futureMarker),
                );
            future
                .prepare(
                    "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, 'future fence', 0)",
                )
                .run(LATEST_SUPPORTED_VERSION + 1);
            future.close();
            const before = fileDigest(dbPath);

            expect(openDatabase(dbPath)).toBeNull();
            expect(getSchemaFenceRejection()).toEqual({
                persistedVersion: LATEST_SUPPORTED_VERSION + 1,
                supportedVersion: LATEST_SUPPORTED_VERSION,
            });
            expect(getFormatRefusal()).toBeNull();
            expect(fileDigest(dbPath)).toBe(before);
        });

        it("#when an exactly-current family carries a newer fence #then still reports a fence rejection", () => {
            const dir = makeTempDir("storage-db-current-newer-fence-");
            const dbPath = join(dir, "context.db");
            // The fence row is the only evidence that a newer binary owns the family when the inventory matches and classification returns `current`.
            // The fence row is the only evidence that a newer binary owns the family when the inventory matches and classification returns `current`.
            // An object-name inventory cannot detect newer-binary ownership when the inventory matches.
            expect(openDatabase(dbPath)).not.toBeNull();
            closeDatabase();
            const bumped = new Database(dbPath);
            bumped
                .prepare(
                    "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, 'future fence', 0)",
                )
                .run(LATEST_SUPPORTED_VERSION + 1);
            bumped.close();

            expect(openDatabase(dbPath)).toBeNull();
            expect(getSchemaFenceRejection()).toEqual({
                persistedVersion: LATEST_SUPPORTED_VERSION + 1,
                supportedVersion: LATEST_SUPPORTED_VERSION,
            });
            expect(getFormatRefusal()).toBeNull();
        });

        it("#when the file is not a database #then throws so callers fail closed", () => {
            const dir = makeTempDir("storage-db-not-a-db-");
            const dbPath = join(dir, "context.db");
            writeFileSync(dbPath, "not a database");

            expect(() => openDatabase(dbPath)).toThrow(/storage unavailable/i);
        });
    });

    describe("#given openDatabase housekeeping", () => {
        it("#when called first time #then restricts storage dir to 0o700 and DB files to 0o600", () => {
            // Skip this test on Windows because Windows does not honor POSIX permission modes.
            if (process.platform === "win32") return;
            const dataHome = useTempDataHome("storage-db-perms-");

            openDatabase();

            const dbPath = resolveDbPath(dataHome);
            const dbDir = dirname(dbPath);
            expect(statSync(dbDir).mode & 0o777).toBe(0o700);
            expect(statSync(dbPath).mode & 0o777).toBe(0o600);
            for (const suffix of ["-wal", "-shm"]) {
                const sidecar = `${dbPath}${suffix}`;
                if (existsSync(sidecar)) {
                    expect(statSync(sidecar).mode & 0o777).toBe(0o600);
                }
            }
        });

        it("#when private permission enforcement is disabled #then a full storage open makes zero chmod calls", () => {
            const dataHome = useTempDataHome("storage-db-external-perms-");
            const chmodCalls: Array<[string, number]> = [];
            setStoragePrivatePermissionEnforcement(false);
            __setStoragePermissionFsForTests({
                chmodSync: ((path, mode) => {
                    chmodCalls.push([String(path), Number(mode)]);
                }) as typeof chmodSync,
            });

            openDatabase();

            expect(existsSync(resolveDbPath(dataHome))).toBe(true);
            expect(chmodCalls).toEqual([]);
        });

        it("#when private permission enforcement is enabled #then a full storage open restricts the directory and database", () => {
            if (process.platform === "win32") return;
            const dataHome = useTempDataHome("storage-db-private-perms-spy-");
            const dbPath = resolveDbPath(dataHome);
            const chmodCalls: Array<[string, number]> = [];
            setStoragePrivatePermissionEnforcement(true);
            __setStoragePermissionFsForTests({
                chmodSync: ((path, mode) => {
                    chmodCalls.push([String(path), Number(mode)]);
                }) as typeof chmodSync,
            });

            openDatabase();

            expect(chmodCalls).toEqual(
                expect.arrayContaining([
                    [dirname(dbPath), 0o700],
                    [dbPath, 0o600],
                ]),
            );
        });

        it("#when downstream rows share context.db #then opens without treating them as future upstream schema", () => {
            const dataHome = useTempDataHome("storage-db-fork-rows-");
            const first = openDatabase();
            expect(first).not.toBeNull();
            first
                ?.prepare(
                    "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?, ?, ?), (?, ?, ?)",
                )
                .run(
                    FORK_MIGRATION_VERSION_FLOOR,
                    "fork migration 10000",
                    0,
                    FORK_MIGRATION_VERSION_FLOOR + 1,
                    "fork migration 10001",
                    0,
                );
            closeDatabase();

            const reopened = openDatabase();
            expect(reopened).not.toBeNull();
            expect(readPersistedVersion(resolveDbPath(dataHome))).toBe(LATEST_SUPPORTED_VERSION);
            expect(
                reopened
                    ?.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version >= ?")
                    .get(FORK_MIGRATION_VERSION_FLOOR),
            ).toEqual({ count: 2 });
        });

        it("#when called first time #then creates required tables", () => {
            useTempDataHome("storage-db-tables-");

            const db = openDatabase();

            const tables = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all() as Array<{ name: string }>;
            const tableNames = tables.map((t) => t.name);
            expect(tableNames).toEqual(
                expect.arrayContaining([
                    "tags",
                    "pending_ops",
                    "source_contents",
                    "compression_depth",
                    "session_meta",
                    "claims",
                    "claim_revisions",
                    "claim_public_ids",
                    "claim_operation_receipts",
                    "mc_format_marker",
                ]),
            );
            expect(tableNames).not.toContain("memories");
            expect(tableNames).not.toContain("memory_embeddings");
            expect(tableNames).not.toContain("legacy_memory_claims");
        });

        it("#when clearSession runs #then every session-scoped table is emptied", () => {
            // The test derives the contract from schema shape instead of maintaining a second table list.
            useTempDataHome("storage-db-clearsession-");
            const db = openDatabase();
            const sessionId = "ses_clearsession_fresh";
            const tableNames = (
                db
                    .prepare(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                    )
                    .all() as Array<{ name: string }>
            )
                .map((row) => row.name)
                .filter((table) => {
                    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                        name: string;
                    }>;
                    return columns.some((column) => column.name === "session_id");
                });

            db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
            for (const table of tableNames) {
                const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                    name: string;
                    type: string;
                    notnull: number;
                    dflt_value: string | null;
                    pk: number;
                }>;
                const insertedColumns = columns.filter(
                    (column) =>
                        column.name === "session_id" ||
                        (column.dflt_value === null &&
                            (column.notnull === 1 ||
                                (column.pk > 0 && column.type.toUpperCase() !== "INTEGER"))),
                );
                const values = insertedColumns.map((column) => {
                    if (column.name === "session_id") return sessionId;
                    const type = column.type.toUpperCase();
                    if (type.includes("INT") || type.includes("REAL")) return 1;
                    if (type.includes("BLOB")) return new Uint8Array([1]);
                    return "seed";
                });
                const placeholders = insertedColumns.map(() => "?").join(", ");
                db.prepare(
                    `INSERT INTO ${table} (${insertedColumns.map((column) => column.name).join(", ")}) VALUES (${placeholders})`,
                ).run(...values);
                expect(
                    db
                        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
                        .get(sessionId),
                ).toEqual({ count: 1 });
            }
            db.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");

            clearSession(db, sessionId);

            for (const table of tableNames) {
                expect(
                    db
                        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`)
                        .get(sessionId),
                    `${table} retained session-scoped rows`,
                ).toEqual({ count: 0 });
            }
        });

        it("#when called first time #then creates required session-scoped indexes", () => {
            useTempDataHome("storage-db-indexes-");

            const db = openDatabase();
            const indexes = db
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
                .all() as Array<{ name: string }>;
            const indexNames = indexes.map((item) => item.name);

            expect(indexNames).toEqual(
                expect.arrayContaining([
                    "idx_tags_session_tag_number",
                    "idx_pending_ops_session",
                    "idx_source_contents_session",
                    "idx_compartments_session",
                    "idx_compression_depth_session",
                    "idx_session_facts_session",
                    "idx_notes_session_status",
                    "idx_notes_project_status",
                    "idx_notes_type_status",
                ]),
            );
        });

        it("#when called a second time #then returns cached instance (singleton)", () => {
            useTempDataHome("storage-db-cached-");

            const db1 = openDatabase();
            const db2 = openDatabase();

            expect(db1).toBe(db2);
        });

        it("#when file path setup fails #then throws so callers fail closed (no in-memory fallback)", () => {
            const dataHome = useTempDataHome("storage-db-fallback-");
            // A file at the `cortexkit` segment makes `mkdirSync` fail.
            writeFileSync(join(dataHome, "cortexkit"), "not-a-directory", "utf-8");

            expect(() => openDatabase()).toThrow(/storage unavailable/i);
        });
    });

    describe("#given closeDatabase", () => {
        it("#when called after openDatabase #then clears the cached instance", () => {
            useTempDataHome("storage-db-close-");

            const db1 = openDatabase();
            closeDatabase();
            const db2 = openDatabase();

            expect(db1).not.toBe(db2);
        });

        it("#when called multiple times #then does not throw", () => {
            useTempDataHome("storage-db-multi-close-");

            openDatabase();
            expect(() => closeDatabase()).not.toThrow();
            expect(() => closeDatabase()).not.toThrow();
            expect(() => closeDatabase()).not.toThrow();
        });

        it("#when called without prior open #then does not throw", () => {
            expect(() => closeDatabase()).not.toThrow();
        });
    });

    // A test run without preload-set isolation must not migrate the shared database.
    // A test run without preload-set isolation must not migrate the shared database.
    // A test run without preload-set isolation must not migrate the shared database.
    // A test run without preload-set isolation must not migrate the shared database.
    // `NODE_ENV=test` must prevent `resolveDatabasePath` from selecting the shared database when isolation variables are absent.
    describe("#given the test-isolation backstop", () => {
        const realStorageRoot = join(homedir(), ".local", "share", "cortexkit");

        it("#when NODE_ENV=test and XDG_DATA_HOME unset #then never resolves to the real shared DB", () => {
            // The test clears all preload-set variables to simulate an unisolated run.
            const savedXdg = process.env.XDG_DATA_HOME;
            const savedTestDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
            process.env.NODE_ENV = "test";
            delete process.env.XDG_DATA_HOME;
            delete process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
            try {
                const { dbPath } = resolveDatabasePath();
                expect(dbPath.startsWith(realStorageRoot)).toBe(false);
                expect(dbPath.includes("mc-test-db-backstop-")).toBe(true);
            } finally {
                if (savedXdg !== undefined) process.env.XDG_DATA_HOME = savedXdg;
                if (savedTestDir !== undefined)
                    process.env.MAGIC_CONTEXT_TEST_DATA_DIR = savedTestDir;
            }
        });

        it("#when a test sets its own XDG_DATA_HOME #then that controlled dir is honored", () => {
            const dataHome = useTempDataHome("storage-db-backstop-xdg-");
            const { dbPath } = resolveDatabasePath();
            expect(dbPath).toBe(resolveDbPath(dataHome));
        });

        it("#then every test package wires the isolation preload (root + plugin + pi-plugin + cli)", () => {
            // A package without bunfig `[test] preload` must still isolate its database path.
            // A package without bunfig `[test] preload` must still isolate its database path.
            const repoRoot = join(__dirname, "..", "..", "..", "..", "..");
            const bunfigs = [
                "bunfig.toml",
                "packages/plugin/bunfig.toml",
                "packages/pi-plugin/bunfig.toml",
                "packages/cli/bunfig.toml",
            ];
            for (const rel of bunfigs) {
                const full = join(repoRoot, rel);
                expect(existsSync(full)).toBe(true);
                const body = readFileSync(full, "utf8");
                expect(body.includes("[test]")).toBe(true);
                expect(body.includes("preload")).toBe(true);
                expect(body.includes("test-preload.ts")).toBe(true);
            }
        });
    });
});

describe("sqlite runtime gate", () => {
    const safeInput = {
        runtime: "Node.js" as const,
        runtimeVersion: "24.18.0",
        sqliteVersion: "3.53.1",
        sqliteSourceId:
            "2026-05-05 10:34:17 c88b22011a54b4f6fbd149e9f8e4de77658ce58143a1af0e3785e4e6475127e9",
    };

    it("passes an approved WAL-reset-safe source", () => {
        expect(evaluateSqliteRuntimeGate(safeInput)).toEqual({ ok: true, reasons: [] });
    });

    it("fails Node 24.14.1 even with a safe SQLite source", () => {
        const result = evaluateSqliteRuntimeGate({ ...safeInput, runtimeVersion: "24.14.1" });
        expect(result.ok).toBe(false);
        expect(result.reasons).toEqual(["Node.js 24.14.1 is below the supported floor 24.15.0"]);
    });

    it("fails an unsafe bundled SQLite source that predates the WAL-reset fix", () => {
        const result = evaluateSqliteRuntimeGate({
            ...safeInput,
            sqliteVersion: "3.46.0",
            sqliteSourceId:
                "2024-05-23 13:25:27 96c92aba00c8375bc32fafcdf12429c58bd8aabfcadab6683e35bbb9cdebf19e",
        });
        expect(result.ok).toBe(false);
        expect(result.reasons).toEqual(["SQLite 3.46.0 is below the supported floor 3.51.3"]);
    });

    it("fails an unknown SQLite source identity", () => {
        const result = evaluateSqliteRuntimeGate({
            ...safeInput,
            sqliteSourceId: "vendor-custom-build",
        });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain("not a recognized SQLite source identity");
    });

    it("fails a Bun runtime below the supported floor", () => {
        const result = evaluateSqliteRuntimeGate({
            ...safeInput,
            runtime: "Bun",
            runtimeVersion: "1.3.13",
        });
        expect(result.ok).toBe(false);
        expect(result.reasons).toEqual(["Bun 1.3.13 is below the supported floor 1.3.14"]);
    });

    it("blocks a production open, not just the off-path probe", () => {
        // The unsafe-runtime gate must run before either production `openDatabase` path opens a connection.
        // The unsafe-runtime gate must run before either production `openDatabase` path opens a connection.
        // The runtime gate must run before Database construction.
        const source = readFileSync(new URL("./storage-db.ts", import.meta.url), "utf8");
        const gate = source.indexOf("const runtimeGate = probeSqliteRuntimeGate();");
        expect(gate).toBeGreaterThan(-1);
        const guardBody = source.slice(gate, gate + 200);
        expect(guardBody).toContain("return null");
        expect(gate).toBeLessThan(source.indexOf("const db = new Database(dbPath);"));
    });

    it("passes the live off-path probe on this supported runtime", () => {
        const report = probeSqliteRuntimeGate();
        expect(report.ok).toBe(true);
        expect(report.input.sqliteVersion.length).toBeGreaterThan(0);
    });
});

describe("sqlite connection contract", () => {
    it("accepts a file-backed connection with the production PRAGMAs", () => {
        const dir = makeTempDir("storage-db-contract-");
        const db = new Database(join(dir, "contract.db"));
        try {
            db.exec("PRAGMA busy_timeout=5000");
            db.exec("PRAGMA foreign_keys=ON");
            db.exec("PRAGMA journal_mode=WAL");
            expect(() =>
                assertSqliteConnectionContract(db, { expectWal: true, minBusyTimeoutMs: 5000 }),
            ).not.toThrow();
        } finally {
            closeQuietly(db);
        }
    });

    it("blocks when foreign keys are disabled", () => {
        const db = new Database(":memory:");
        try {
            db.exec("PRAGMA busy_timeout=5000");
            expect(() => assertSqliteConnectionContract(db, { expectWal: false })).toThrow(
                /foreign_keys is disabled/,
            );
        } finally {
            closeQuietly(db);
        }
    });

    it("blocks when WAL activation did not stick", () => {
        const db = new Database(":memory:");
        try {
            db.exec("PRAGMA busy_timeout=5000");
            db.exec("PRAGMA foreign_keys=ON");
            expect(() => assertSqliteConnectionContract(db, { expectWal: true })).toThrow(
                /journal_mode is 'memory', expected 'wal'/,
            );
        } finally {
            closeQuietly(db);
        }
    });

    it("blocks when the busy timeout is missing", () => {
        const db = new Database(":memory:");
        try {
            db.exec("PRAGMA foreign_keys=ON");
            db.exec("PRAGMA busy_timeout=0");
            expect(() => assertSqliteConnectionContract(db, { expectWal: false })).toThrow(
                /busy_timeout 0ms is below the required 1ms/,
            );
        } finally {
            closeQuietly(db);
        }
    });

    it("blocks a synchronous mode outside the declared set", () => {
        const db = new Database(":memory:");
        try {
            db.exec("PRAGMA busy_timeout=5000");
            db.exec("PRAGMA foreign_keys=ON");
            db.exec("PRAGMA synchronous=OFF");
            expect(() => assertSqliteConnectionContract(db, { expectWal: false })).toThrow(
                /synchronous mode 0 is not in the declared set/,
            );
        } finally {
            closeQuietly(db);
        }
    });
});
