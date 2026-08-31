import { spawnSync } from "node:child_process";
import {
    chmodSync,
    closeSync,
    constants,
    copyFileSync,
    existsSync,
    mkdtempSync,
    openSync,
    renameSync,
    rmSync,
    statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureContextStoreUuid } from "@magic-context/core/features/magic-context/context-authority";
import {
    composeRegisteredSchema,
    computeExpectedDirectFormat,
} from "@magic-context/core/features/magic-context/storage-current-schema";
import {
    getPersistedSchemaVersion,
    inspectRpcServerDiscovery,
} from "@magic-context/core/features/magic-context/storage-db";
import {
    buildDirectFormatMarker,
    classifyDatabaseFormatFamily,
    createDirectFormatMarkerSchema,
    databaseResetMarkerPath,
    type FormatFamilyClassification,
    inspectDatabaseForClassification,
    MC_APPLICATION_ID,
    readDirectFormatMarker,
    stampDirectFormatMarker,
} from "@magic-context/core/features/magic-context/storage-format-epoch";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { inspectLivePiProcesses } from "@magic-context/core/shared/rpc-utils";
import { Database, type Database as DatabaseType } from "@magic-context/core/shared/sqlite";

import { DATABASE_RESET_COMMAND } from "../lib/database-repair-guidance";
import { type PromptIO, promptIO } from "../lib/prompts";

const ROW_COUNT_TABLES = ["tags", "compartments", "claims", "notes", "dream_runs"] as const;
const DATABASE_SUFFIXES = ["", "-wal", "-shm"] as const;

export const REPAIR_DB_EXIT = {
    salvaged: 0,
    failed: 1,
    unsalvageable: 2,
    refused: 3,
} as const;

type RepairDbExitCode = (typeof REPAIR_DB_EXIT)[keyof typeof REPAIR_DB_EXIT];
type RowCounts = Record<(typeof ROW_COUNT_TABLES)[number], number | null>;

export interface DatabaseHolderInspection {
    safe: boolean;
    blockers: string[];
    uncertainty?: string;
}

interface RepairDbDeps {
    now: () => Date;
    sqliteExecutable: string;
    inspectHolders: (storageDir: string) => DatabaseHolderInspection;
}

export interface RunRepairDbOptions {
    dbPath?: string;
    storageDir?: string;
    prompts?: PromptIO;
    deps?: Partial<RepairDbDeps>;
}

interface BackupBundle {
    basePath: string;
    copiedPaths: string[];
}

interface SalvageResult {
    ok: boolean;
    detail?: string;
    afterCounts?: RowCounts;
    schemaVersionBefore?: number;
    schemaVersionAfter?: number;
}

export function defaultInspectHolders(storageDir: string): DatabaseHolderInspection {
    const rpc = inspectRpcServerDiscovery(storageDir);
    if (rpc.state === "unreadable") {
        const arm = rpc.unreadableArm === "parse" ? "could not be parsed" : "could not be read";
        return {
            safe: false,
            blockers: [],
            uncertainty: `RPC discovery ${rpc.unreadableFile ?? join(storageDir, "rpc")} ${arm}`,
        };
    }

    const blockers =
        rpc.state === "live" ? rpc.serverPids.map((pid) => `OpenCode server (PID ${pid})`) : [];
    const pi = inspectLivePiProcesses();
    if (pi.state === "unreadable") {
        return {
            safe: false,
            blockers,
            uncertainty: `Pi/OMP process liveness could not be determined: ${pi.error ?? "process list unavailable"}`,
        };
    }
    blockers.push(...pi.processIds.map((pid) => `Pi/OMP harness (PID ${pid})`));
    return { safe: blockers.length === 0, blockers };
}

export function defaultSqliteExecutable(): string {
    return process.env.MAGIC_CONTEXT_SQLITE3 ?? "sqlite3";
}

function classifyOpenDatabase(db: DatabaseType, path: string): FormatFamilyClassification {
    return classifyDatabaseFormatFamily(
        inspectDatabaseForClassification(db, path),
        computeExpectedDirectFormat(),
    );
}

// The probe uses a private scratch copy because a read-only SQLite open can rewrite an existing SHM file.
// classifyDatabaseFamily returns null for unreadable contents; migrateAndCheckRecoveredDatabase re-validates after `.recover`.
function classifyDatabaseFamily(dbPath: string): FormatFamilyClassification | null {
    let probeDir: string | null = null;
    let db: DatabaseType | null = null;
    try {
        probeDir = mkdtempSync(join(tmpdir(), "mc-repair-format-probe-"));
        const probePath = join(probeDir, "probe.db");
        for (const suffix of DATABASE_SUFFIXES) {
            const source = `${dbPath}${suffix}`;
            if (existsSync(source)) copyFileSync(source, `${probePath}${suffix}`);
        }
        db = new Database(probePath, { readonly: true });
        return classifyOpenDatabase(db, probePath);
    } catch {
        return null;
    } finally {
        db?.close();
        if (probeDir !== null) rmSync(probeDir, { recursive: true, force: true });
    }
}

const DEFAULT_DEPS: RepairDbDeps = {
    now: () => new Date(),
    sqliteExecutable: defaultSqliteExecutable(),
    inspectHolders: defaultInspectHolders,
};

function timestamp(date: Date): string {
    return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

function uniqueBase(preferred: string): string {
    if (!DATABASE_SUFFIXES.some((suffix) => existsSync(`${preferred}${suffix}`))) return preferred;
    for (let attempt = 1; attempt < 10_000; attempt++) {
        const candidate = `${preferred}-${attempt}`;
        if (!DATABASE_SUFFIXES.some((suffix) => existsSync(`${candidate}${suffix}`)))
            return candidate;
    }
    throw new Error(`Could not allocate a unique recovery path beside ${preferred}`);
}

function copyBackupBundle(dbPath: string, stamp: string): BackupBundle {
    const basePath = uniqueBase(`${dbPath}.corrupt-backup-${stamp}`);
    const copiedPaths = copyDatabaseBundle(dbPath, basePath);
    return { basePath, copiedPaths };
}

function copyDatabaseBundle(sourceBase: string, destinationBase: string): string[] {
    const copiedPaths: string[] = [];
    for (const suffix of DATABASE_SUFFIXES) {
        const source = `${sourceBase}${suffix}`;
        if (!existsSync(source)) continue;
        const destination = `${destinationBase}${suffix}`;
        copyFileSync(source, destination, constants.COPYFILE_EXCL);
        copiedPaths.push(destination);
    }
    return copiedPaths;
}

function readRowCounts(path: string): RowCounts {
    const counts = Object.fromEntries(ROW_COUNT_TABLES.map((table) => [table, null])) as RowCounts;
    let db: DatabaseType | null = null;
    try {
        db = new Database(path, { readonly: true });
        for (const table of ROW_COUNT_TABLES) {
            try {
                const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
                    | { count?: unknown }
                    | undefined;
                counts[table] = typeof row?.count === "number" ? row.count : null;
            } catch {
                counts[table] = null;
            }
        }
    } catch {
    } finally {
        db?.close();
    }
    return counts;
}

function reportCounts(prompts: PromptIO, label: "BEFORE" | "AFTER", counts: RowCounts): void {
    prompts.log.info(`Row counts ${label} recovery:`);
    for (const table of ROW_COUNT_TABLES) {
        prompts.log.info(`  ${table}=${counts[table] ?? "n/a"}`);
    }
}

function reportSchemaTransition(prompts: PromptIO, result: SalvageResult): void {
    prompts.log.info(
        `Schema migration: v${result.schemaVersionBefore ?? "unknown"} → v${result.schemaVersionAfter ?? "unknown"}`,
    );
}

function reportSalvageRates(prompts: PromptIO, before: RowCounts, after: RowCounts): void {
    prompts.log.info("Salvage rates (readable rows before → rows after):");
    for (const table of ROW_COUNT_TABLES) {
        const beforeCount = before[table];
        const afterCount = after[table];
        if (beforeCount === null || afterCount === null) {
            prompts.log.info(`  ${table}: n/a`);
            continue;
        }
        const rate =
            beforeCount === 0 ? (afterCount === 0 ? 100 : 0) : (afterCount / beforeCount) * 100;
        const lost = Math.max(0, beforeCount - afterCount);
        prompts.log.info(
            `  ${table}: ${beforeCount} → ${afterCount} (${rate.toFixed(1)}%, lost ${lost})`,
        );
    }
}

function integrityErrors(db: DatabaseType): string[] {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{
        integrity_check?: unknown;
    }>;
    return rows
        .map((row) => String(row.integrity_check ?? "unknown"))
        .filter((result) => result !== "ok");
}

function sqliteError(result: ReturnType<typeof spawnSync>): string {
    if (result.error) return result.error.message;
    const stderr = String(result.stderr ?? "").trim();
    if (stderr) return stderr;
    return `sqlite3 exited with status ${String(result.status)}`;
}

// `.recover` reads raw database pages through the sqlite_dbpage virtual table.
// The `sqlite_dbpage` virtual table requires `SQLITE_ENABLE_DBPAGE_VTAB`.
// A shell without `SQLITE_ENABLE_DBPAGE_VTAB` fails when `.recover` accesses `sqlite_dbpage`.
// Shells older than SQLite 3.29 do not support `.recover`.
// Missing-capability errors indicate missing SQLite capabilities, not data loss.
// A missing-capability error stops recovery without offering recovery.
// Data-level `.recover` failures are recovery failures.
const RECOVER_UNAVAILABLE_PATTERNS = [
    /no such table: sqlite_dbpage/i,
    /no such module: sqlite_dbpage/i,
    /unknown command[^\n]*\.recover/i,
] as const;

function isRecoverCapabilityMissing(errorDetail: string): boolean {
    return RECOVER_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(errorDetail));
}

function runRecoverShell(
    sqliteExecutable: string,
    sourcePath: string,
    recoveredPath: string,
    dumpPath: string,
): { ok: true } | { ok: false; detail: string; attempted: boolean; unavailable: boolean } {
    let dumpWriteFd: number | null = null;
    try {
        dumpWriteFd = openSync(dumpPath, "wx", 0o600);
        const recovered = spawnSync(sqliteExecutable, [sourcePath, ".recover"], {
            stdio: ["ignore", dumpWriteFd, "pipe"],
            encoding: "utf8",
            windowsHide: true,
        });
        closeSync(dumpWriteFd);
        dumpWriteFd = null;
        if (recovered.error || recovered.status !== 0) {
            const errorDetail = sqliteError(recovered);
            const attempted = recovered.error === undefined;
            return {
                ok: false,
                detail: `.recover failed: ${errorDetail}`,
                attempted,
                // Only a shell that ran can report a missing capability.
                // A spawn failure produces a could-not-start error.
                unavailable: attempted && isRecoverCapabilityMissing(errorDetail),
            };
        }

        const dumpReadFd = openSync(dumpPath, "r");
        try {
            const replayed = spawnSync(sqliteExecutable, [recoveredPath], {
                stdio: [dumpReadFd, "ignore", "pipe"],
                encoding: "utf8",
                windowsHide: true,
            });
            if (replayed.error || replayed.status !== 0) {
                return {
                    ok: false,
                    detail: `replaying .recover output failed: ${sqliteError(replayed)}`,
                    attempted: true,
                    // The replay step executes only SQL emitted by `.recover`.
                    // A replay failure occurs after the shell emits `.recover` SQL.
                    unavailable: false,
                };
            }
        } finally {
            closeSync(dumpReadFd);
        }
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
            attempted: false,
            unavailable: false,
        };
    } finally {
        if (dumpWriteFd !== null) closeSync(dumpWriteFd);
        rmSync(dumpPath, { force: true });
    }
}

function migrateAndCheckRecoveredDatabase(path: string): SalvageResult {
    let db: DatabaseType | null = null;
    try {
        db = new Database(path);
        db.exec("PRAGMA busy_timeout=5000");
        db.exec("PRAGMA foreign_keys=ON");
        const marker = readDirectFormatMarker(db);
        if (marker.status !== "present") {
            const why = marker.status === "malformed" ? ` (${marker.reason})` : "";
            return {
                ok: false,
                detail:
                    `the recovered contents carry no valid direct-format marker${why}; ` +
                    `this command repairs only the supported direct claims format — run \`${DATABASE_RESET_COMMAND}\` to abandon the family`,
            };
        }
        // Classification requires the original `application_id` and `user_version`.
        // pi-lens-ignore: sql-injection
        db.exec(`PRAGMA application_id = ${MC_APPLICATION_ID}`);
        // pi-lens-ignore: sql-injection
        db.exec(`PRAGMA user_version = ${marker.marker.formatEpoch}`);
        const classification = classifyOpenDatabase(db, path);
        if (classification.family !== "current") {
            return {
                ok: false,
                detail:
                    `the recovered database is not the exact current direct format (${classification.family}): ` +
                    `${classification.reasons.join("; ")} — run \`${DATABASE_RESET_COMMAND}\` to abandon the family`,
            };
        }

        const schemaVersionBefore = getPersistedSchemaVersion(db);
        ensureContextStoreUuid(db);
        const schemaVersionAfter = getPersistedSchemaVersion(db);
        const errors = integrityErrors(db);
        if (errors.length > 0) {
            return {
                ok: false,
                detail: `recovered database integrity_check failed: ${errors.slice(0, 3).join("; ")}`,
            };
        }
        const afterCounts = readCountsFromOpenDatabase(db);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.exec("PRAGMA journal_mode=DELETE");
        return { ok: true, afterCounts, schemaVersionBefore, schemaVersionAfter };
    } catch (error) {
        return {
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
        };
    } finally {
        db?.close();
    }
}

function readCountsFromOpenDatabase(db: DatabaseType): RowCounts {
    const counts = Object.fromEntries(ROW_COUNT_TABLES.map((table) => [table, null])) as RowCounts;
    for (const table of ROW_COUNT_TABLES) {
        try {
            const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
                | { count?: unknown }
                | undefined;
            counts[table] = typeof row?.count === "number" ? row.count : null;
        } catch {
            counts[table] = null;
        }
    }
    return counts;
}

function prepareFreshDatabase(path: string): SalvageResult {
    let db: DatabaseType | null = null;
    try {
        db = new Database(path);
        db.exec("PRAGMA busy_timeout=5000");
        db.exec("PRAGMA foreign_keys=ON");
        const schemaVersionBefore = getPersistedSchemaVersion(db);
        const expected = computeExpectedDirectFormat();
        const fresh = db;
        fresh
            .transaction(() => {
                composeRegisteredSchema(fresh);
                createDirectFormatMarkerSchema(fresh);
                stampDirectFormatMarker(
                    fresh,
                    buildDirectFormatMarker({
                        componentManifestDigest: expected.componentManifestDigest,
                        createdAtMs: Date.now(),
                    }),
                );
            })
            .immediate();
        ensureContextStoreUuid(db);
        const schemaVersionAfter = getPersistedSchemaVersion(db);
        const errors = integrityErrors(db);
        if (errors.length > 0) {
            return {
                ok: false,
                detail: `fresh database integrity_check failed: ${errors.join("; ")}`,
            };
        }
        const afterCounts = readCountsFromOpenDatabase(db);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.exec("PRAGMA journal_mode=DELETE");
        return { ok: true, afterCounts, schemaVersionBefore, schemaVersionAfter };
    } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    } finally {
        db?.close();
    }
}

function removeRecoveryBundle(basePath: string): void {
    for (const suffix of DATABASE_SUFFIXES) rmSync(`${basePath}${suffix}`, { force: true });
}

function activateReplacement(
    dbPath: string,
    replacementPath: string,
    originalAsidePath: string,
): string[] {
    const movedOriginals: Array<{ from: string; to: string }> = [];
    try {
        for (const suffix of DATABASE_SUFFIXES) {
            const from = `${dbPath}${suffix}`;
            if (!existsSync(from)) continue;
            const to = `${originalAsidePath}${suffix}`;
            renameSync(from, to);
            movedOriginals.push({ from, to });
        }
        renameSync(replacementPath, dbPath);
        return movedOriginals.map(({ to }) => to);
    } catch (error) {
        for (const moved of movedOriginals.reverse()) {
            if (existsSync(moved.to) && !existsSync(moved.from)) renameSync(moved.to, moved.from);
        }
        throw error;
    }
}

function reportSafetyRefusal(
    prompts: PromptIO,
    dbPath: string,
    inspection: DatabaseHolderInspection,
    backupBase?: string,
): RepairDbExitCode {
    prompts.log.error(`Refusing to repair the live database: ${dbPath}`);
    if (inspection.blockers.length > 0) {
        prompts.log.error(`Active database holder(s): ${inspection.blockers.join(", ")}`);
    }
    if (inspection.uncertainty) prompts.log.error(inspection.uncertainty);
    prompts.log.info("Close every OpenCode, Pi, and OMP process, then run the command again.");
    if (backupBase) prompts.log.info(`Backup base: ${backupBase}`);
    else prompts.log.info("Backup: not created (repair refused before database access)");
    prompts.outro("Database repair refused; the original database files were not modified");
    return REPAIR_DB_EXIT.refused;
}

function printHelp(): void {
    console.log("Usage: magic-context doctor repair-db");
    console.log("");
    console.log("Back up and salvage the shared context.db using SQLite .recover.");
    console.log(
        "If salvage is impossible, an empty reset is offered with a separate confirmation.",
    );
    console.log(
        "Salvage needs a sqlite3 shell built with SQLITE_ENABLE_DBPAGE_VTAB; without one, the command backs up and stops without modifying the database.",
    );
    console.log(
        "Legacy-format, unsupported, and reset-pending databases are refused; use `magic-context doctor reset-db` for those.",
    );
}

export async function runRepairDb(options: RunRepairDbOptions = {}): Promise<RepairDbExitCode> {
    const prompts = options.prompts ?? promptIO;
    const deps: RepairDbDeps = { ...DEFAULT_DEPS, ...options.deps };
    const storageDir =
        options.storageDir ??
        dirname(options.dbPath ?? join(getMagicContextStorageDir(), "context.db"));
    const dbPath = options.dbPath ?? join(storageDir, "context.db");
    const stamp = timestamp(deps.now());

    prompts.intro("Magic Context — Repair shared database");
    prompts.log.info(`Database: ${dbPath}`);
    if (!existsSync(dbPath)) {
        prompts.log.error(`Database not found: ${dbPath}`);
        prompts.log.info("Backup: not created (database does not exist)");
        prompts.outro("Database repair failed");
        return REPAIR_DB_EXIT.failed;
    }

    // Repair salvages only the supported direct claims format.
    if (existsSync(databaseResetMarkerPath(dbPath))) {
        prompts.log.error(`A database reset is pending for this family: ${dbPath}`);
        prompts.log.info(
            `Complete or roll back the reset first: run \`${DATABASE_RESET_COMMAND}\`. No salvage was attempted and no file was changed.`,
        );
        prompts.outro("Database repair refused; a reset is pending");
        return REPAIR_DB_EXIT.refused;
    }

    const initialInspection = deps.inspectHolders(storageDir);
    if (!initialInspection.safe) return reportSafetyRefusal(prompts, dbPath, initialInspection);

    const familyClassification = classifyDatabaseFamily(dbPath);
    if (
        familyClassification !== null &&
        familyClassification.family !== "current" &&
        familyClassification.family !== "malformed-marker"
    ) {
        prompts.log.error(
            `This database is not the supported direct claims format (${familyClassification.family}): ${familyClassification.reasons.join("; ")}`,
        );
        prompts.log.info(
            `doctor repair-db repairs only the supported direct claims format. For a legacy or unsupported family the only supported action is an explicit reset: run \`${DATABASE_RESET_COMMAND}\`. No salvage was attempted and no file was changed.`,
        );
        prompts.outro("Database repair refused; use doctor reset-db");
        return REPAIR_DB_EXIT.refused;
    }

    let backup: BackupBundle;
    try {
        backup = copyBackupBundle(dbPath, stamp);
    } catch (error) {
        prompts.log.error(
            `Could not complete the required backup: ${error instanceof Error ? error.message : String(error)}`,
        );
        prompts.log.info(`Backup base: ${dbPath}.corrupt-backup-${stamp}`);
        prompts.outro("Database repair stopped before salvage");
        return REPAIR_DB_EXIT.failed;
    }
    for (const path of backup.copiedPaths) prompts.log.info(`Backup: ${path}`);

    const workingBase = uniqueBase(`${dbPath}.recovering-${stamp}-${process.pid}`);
    const countSourcePath = `${workingBase}.count-source`;
    const recoverSourcePath = `${workingBase}.recover-source`;
    try {
        copyDatabaseBundle(backup.basePath, countSourcePath);
    } catch (error) {
        removeRecoveryBundle(countSourcePath);
        prompts.log.error(
            `Could not prepare the isolated row-count snapshot: ${error instanceof Error ? error.message : String(error)}`,
        );
        prompts.log.info(`Database remains unchanged: ${dbPath}`);
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database repair stopped before salvage");
        return REPAIR_DB_EXIT.failed;
    }
    const beforeCounts = readRowCounts(countSourcePath);
    removeRecoveryBundle(countSourcePath);
    reportCounts(prompts, "BEFORE", beforeCounts);

    try {
        copyDatabaseBundle(backup.basePath, recoverSourcePath);
    } catch (error) {
        removeRecoveryBundle(recoverSourcePath);
        prompts.log.error(
            `Could not prepare the isolated salvage snapshot: ${error instanceof Error ? error.message : String(error)}`,
        );
        prompts.log.info(`Database remains unchanged: ${dbPath}`);
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database repair stopped before salvage");
        return REPAIR_DB_EXIT.failed;
    }
    const recoveredPath = `${workingBase}.db`;
    const dumpPath = `${workingBase}.sql`;
    prompts.log.info(`Attempting SQLite .recover into fresh database: ${recoveredPath}`);
    const salvage = runRecoverShell(
        deps.sqliteExecutable,
        recoverSourcePath,
        recoveredPath,
        dumpPath,
    );
    removeRecoveryBundle(recoverSourcePath);
    if (!salvage.ok && !salvage.attempted) {
        removeRecoveryBundle(recoveredPath);
        const unavailableAfter = Object.fromEntries(
            ROW_COUNT_TABLES.map((table) => [table, null]),
        ) as RowCounts;
        reportCounts(prompts, "AFTER", unavailableAfter);
        reportSalvageRates(prompts, beforeCounts, unavailableAfter);
        prompts.log.error(`SQLite .recover could not be started: ${salvage.detail}`);
        prompts.log.info(
            "Install the SQLite command-line shell (sqlite3), then rerun this command. Reset was not offered because salvage did not run.",
        );
        prompts.log.info(`Database remains unchanged: ${dbPath}`);
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database repair stopped before salvage could run");
        return REPAIR_DB_EXIT.failed;
    }
    if (!salvage.ok && salvage.unavailable) {
        // A shell without required recovery capabilities cannot determine whether the database is salvageable.
        // Handling a missing-capability error leaves the database untouched, retains the named backup, and skips the destructive reset.
        // The repair flow exits with `failed`, not `unsalvageable`, on a missing-capability error.
        removeRecoveryBundle(recoveredPath);
        const unavailableAfter = Object.fromEntries(
            ROW_COUNT_TABLES.map((table) => [table, null]),
        ) as RowCounts;
        reportCounts(prompts, "AFTER", unavailableAfter);
        reportSalvageRates(prompts, beforeCounts, unavailableAfter);
        prompts.log.error(`SQLite .recover is unavailable on this machine: ${salvage.detail}`);
        prompts.log.info(
            "This sqlite3 was built without SQLITE_ENABLE_DBPAGE_VTAB, the compile-time option .recover needs. That is a limitation of the tool, not a verdict about your data: the database may be perfectly salvageable with a full sqlite3 build. Install the official SQLite command-line binary (sqlite.org/download.html) or a distro package built with SQLITE_ENABLE_DBPAGE_VTAB, then rerun this command. Reset was not offered because salvage did not run.",
        );
        prompts.log.info(`Database remains unchanged: ${dbPath}`);
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database repair stopped: this sqlite3 cannot run .recover");
        return REPAIR_DB_EXIT.failed;
    }
    let salvageResult: SalvageResult;
    if (salvage.ok) {
        salvageResult = migrateAndCheckRecoveredDatabase(recoveredPath);
    } else {
        salvageResult = salvage;
    }

    if (salvageResult.ok && salvageResult.afterCounts) {
        const finalInspection = deps.inspectHolders(storageDir);
        if (!finalInspection.safe) {
            removeRecoveryBundle(recoveredPath);
            return reportSafetyRefusal(prompts, dbPath, finalInspection, backup.basePath);
        }
        try {
            const originalMode = statSync(dbPath).mode & 0o777;
            chmodSync(recoveredPath, originalMode);
            const originalAsidePath = uniqueBase(`${dbPath}.corrupt-original-${stamp}`);
            const moved = activateReplacement(dbPath, recoveredPath, originalAsidePath);
            reportSchemaTransition(prompts, salvageResult);
            reportCounts(prompts, "AFTER", salvageResult.afterCounts);
            reportSalvageRates(prompts, beforeCounts, salvageResult.afterCounts);
            for (const path of moved) prompts.log.info(`Corrupt original preserved: ${path}`);
            prompts.log.success(`Salvaged database installed: ${dbPath}`);
            prompts.log.info(`Backup base: ${backup.basePath}`);
            prompts.outro("Database salvage complete; restart your harness");
            return REPAIR_DB_EXIT.salvaged;
        } catch (error) {
            salvageResult = {
                ok: false,
                detail: `could not install recovered database: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    // The repair flow keeps the salvaged bundle when `.recover` emits `lost_and_found`.
    // The exact-inventory gate rejects the unregistered `lost_and_found` table.
    // Recoveries with `lost_and_found` rows fail classification despite retaining recoverable data.
    // Deleting recoveries with `lost_and_found` would discard recoverable data before the operator sees it.
    const unavailableAfter = Object.fromEntries(
        ROW_COUNT_TABLES.map((table) => [table, null]),
    ) as RowCounts;
    reportCounts(prompts, "AFTER", unavailableAfter);
    reportSalvageRates(prompts, beforeCounts, unavailableAfter);
    prompts.log.error(
        `SQLite salvage was unsuccessful: ${salvageResult.detail ?? "unknown error"}`,
    );
    prompts.log.info(`Database remains unchanged: ${dbPath}`);
    prompts.log.info(`Backup base: ${backup.basePath}`);
    if (existsSync(recoveredPath)) {
        prompts.log.warn(
            `Salvaged contents retained for inspection: ${recoveredPath}. This command installs only the exact registered direct format, so a recovery carrying extra objects (for example a \`lost_and_found\` table from unattributed pages) is not installed automatically. Inspect it with \`sqlite3 ${recoveredPath} '.tables'\` before deciding; delete it once you no longer need it.`,
        );
    }

    const confirmed = await prompts.confirm(
        "Salvage failed. Move the corrupt database aside and create a fresh empty database? This discards all unrecovered data from the active database.",
        false,
    );
    if (!confirmed) {
        prompts.log.info("Reset declined. The corrupt database remains in place.");
        prompts.outro("Database is unsalvageable by this command; backup retained");
        return REPAIR_DB_EXIT.unsalvageable;
    }

    const resetInspection = deps.inspectHolders(storageDir);
    if (!resetInspection.safe) {
        return reportSafetyRefusal(prompts, dbPath, resetInspection, backup.basePath);
    }

    const freshPath = `${workingBase}.fresh.db`;
    const fresh = prepareFreshDatabase(freshPath);
    if (!fresh.ok || !fresh.afterCounts) {
        removeRecoveryBundle(freshPath);
        prompts.log.error(`Could not create a fresh database: ${fresh.detail ?? "unknown error"}`);
        prompts.log.info(`Database remains unchanged: ${dbPath}`);
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database reset failed");
        return REPAIR_DB_EXIT.failed;
    }

    try {
        const originalMode = statSync(dbPath).mode & 0o777;
        chmodSync(freshPath, originalMode);
        const originalAsidePath = uniqueBase(`${dbPath}.corrupt-original-${stamp}`);
        const moved = activateReplacement(dbPath, freshPath, originalAsidePath);
        reportSchemaTransition(prompts, fresh);
        reportCounts(prompts, "AFTER", fresh.afterCounts);
        reportSalvageRates(prompts, beforeCounts, fresh.afterCounts);
        for (const path of moved) prompts.log.info(`Corrupt original preserved: ${path}`);
        prompts.log.success(
            `Fresh database installed after explicit reset confirmation: ${dbPath}`,
        );
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database reset complete; restart your harness");
        return REPAIR_DB_EXIT.salvaged;
    } catch (error) {
        prompts.log.error(
            `Could not install the fresh database: ${error instanceof Error ? error.message : String(error)}`,
        );
        prompts.log.info(`Database remains unchanged: ${dbPath}`);
        prompts.log.info(`Backup base: ${backup.basePath}`);
        prompts.outro("Database reset failed");
        return REPAIR_DB_EXIT.failed;
    }
}

export async function runRepairDbCli(
    args: string[],
    options: RunRepairDbOptions = {},
): Promise<RepairDbExitCode> {
    if (args.includes("--help") || args.includes("-h")) {
        printHelp();
        return REPAIR_DB_EXIT.salvaged;
    }
    return runRepairDb(options);
}
