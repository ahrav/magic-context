/**
 * `doctor reset-db` abandons an unsupported database family without
 * migrating, salvaging, or deleting data.
 *
 * The reset marker is published BEFORE the final holder inspection and binds
 * the database incarnation plus dev/inode of every family file; holders and
 * identities are rechecked before every move. Quarantine moves the rollback
 * journal, WAL, SHM, main file, and finally the marker into a same-directory
 * private directory. Each rename is atomic because the source and destination
 * are on the same filesystem, so an interruption at any point leaves either
 * the original family plus a pending marker (resumable) or a complete
 * quarantine.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
    buildDatabaseResetMarker,
    captureDatabaseFamilyIdentities,
    DATABASE_FAMILY_MOVE_ORDER,
    DATABASE_QUARANTINE_DIR_INFIX,
    type DatabaseFileIdentity,
    type DatabaseResetMarker,
    databaseFamilyFilePath,
    databaseResetMarkerPath,
    type ResetMarkerFamilyVerification,
    verifyResetMarkerFamily,
    writeDatabaseResetMarker,
} from "@magic-context/core/features/magic-context/storage-format-epoch";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import {
    type DirectDatabaseFamilyState,
    inspectDirectDatabaseFamilyState,
} from "../lib/database-access";
import { DATABASE_RESET_COMMAND } from "../lib/database-repair-guidance";
import { type PromptIO, promptIO } from "../lib/prompts";
import { type DatabaseHolderInspection, defaultInspectHolders } from "./doctor-repair-db";

export const RESET_DB_EXIT = {
    ok: 0,
    failed: 1,
    declined: 2,
    refused: 3,
} as const;

type ResetDbExitCode = (typeof RESET_DB_EXIT)[keyof typeof RESET_DB_EXIT];

interface ResetDbDeps {
    now: () => Date;
    inspectHolders: (storageDir: string) => DatabaseHolderInspection;
}

export interface RunResetDbOptions {
    dbPath?: string;
    storageDir?: string;
    prompts?: PromptIO;
    deps?: Partial<ResetDbDeps>;
    dryRun?: boolean;
    yes?: boolean;
}

const DEFAULT_DEPS: ResetDbDeps = {
    now: () => new Date(),
    inspectHolders: defaultInspectHolders,
};

const RETENTION_NOTE =
    "Quarantine is logical abandonment, not secure erasure; the quarantined files are retained at that path until you delete them yourself.";

function timestamp(date: Date): string {
    return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

function allocateQuarantineDirPath(dbPath: string, stamp: string): string {
    const preferred = `${dbPath}${DATABASE_QUARANTINE_DIR_INFIX}${stamp}`;
    if (!existsSync(preferred)) return preferred;
    for (let attempt = 1; attempt < 10_000; attempt++) {
        const candidate = `${preferred}-${attempt}`;
        if (!existsSync(candidate)) return candidate;
    }
    throw new Error(`Could not allocate a unique quarantine path beside ${dbPath}`);
}

function ensureQuarantineDir(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    // mkdirSync applies the mode only when it creates the directory; a resumed
    // quarantine re-enforces the private permission on the existing one.
    chmodSync(path, 0o700);
}

function moveIntoQuarantine(sourcePath: string, quarantineDirPath: string): string {
    ensureQuarantineDir(quarantineDirPath);
    const destination = join(quarantineDirPath, basename(sourcePath));
    renameSync(sourcePath, destination);
    chmodSync(destination, 0o600);
    return destination;
}

function describeFamilyState(state: DirectDatabaseFamilyState): string {
    switch (state.state) {
        case "pristine":
            return "pristine (no database family)";
        case "current":
            return `current direct format (database incarnation ${state.databaseIncarnationId})`;
        case "reset-pending":
            return "reset-pending (an interrupted reset marker exists)";
        case "unsupported":
            return `unsupported (${state.family})`;
        case "corrupt":
            return `corrupt (${state.detail})`;
    }
}

function reportIdentities(
    prompts: PromptIO,
    identities: readonly DatabaseFileIdentity[],
    dbPath: string,
): void {
    if (identities.length === 0) {
        prompts.log.info("Family files: none on disk");
        return;
    }
    prompts.log.info("Family files to abandon:");
    for (const file of identities) {
        prompts.log.info(
            `  ${file.role}: ${databaseFamilyFilePath(dbPath, file.role)} (dev=${file.dev} inode=${file.ino} bytes=${file.sizeBytes})`,
        );
    }
}

function reportPlan(
    prompts: PromptIO,
    dbPath: string,
    familyLabel: string,
    reasons: readonly string[],
    databaseIncarnationId: string | null,
    identities: readonly DatabaseFileIdentity[],
    quarantineDirPath: string,
): void {
    prompts.log.info(`Database family: ${familyLabel}`);
    for (const reason of reasons) prompts.log.info(`  reason: ${reason}`);
    prompts.log.info(
        `Database incarnation: ${databaseIncarnationId ?? "none readable from this family"}`,
    );
    reportIdentities(prompts, identities, dbPath);
    prompts.log.info(`Quarantine destination: ${quarantineDirPath} (0700 directory, 0600 files)`);
    prompts.log.warn(
        "Reset abandons ALL logical data in the files above. Nothing is migrated or salvaged.",
    );
    prompts.log.info(RETENTION_NOTE);
}

function reportSafetyRefusal(
    prompts: PromptIO,
    dbPath: string,
    inspection: DatabaseHolderInspection,
): void {
    prompts.log.error(`Refusing to reset the database family: ${dbPath}`);
    if (inspection.blockers.length > 0) {
        prompts.log.error(`Active database holder(s): ${inspection.blockers.join(", ")}`);
    }
    if (inspection.uncertainty) prompts.log.error(inspection.uncertainty);
    prompts.log.info("Close every OpenCode, Pi, and OMP process, then run the command again.");
}

function refuseQuarantine(
    prompts: PromptIO,
    dbPath: string,
    marker: DatabaseResetMarker,
    verification: ResetMarkerFamilyVerification,
    cause: { problems?: readonly string[]; holders?: DatabaseHolderInspection },
): ResetDbExitCode {
    if (cause.holders) {
        reportSafetyRefusal(prompts, dbPath, cause.holders);
    } else {
        prompts.log.error(`Refusing to quarantine the database family: ${dbPath}`);
        for (const problem of cause.problems ?? []) prompts.log.error(`  ${problem}`);
    }
    if (verification.anyMoved) {
        prompts.log.info(
            `The interrupted quarantine remains pending at ${marker.quarantineDirPath}; re-run \`${DATABASE_RESET_COMMAND}\` once the blocker is resolved.`,
        );
        prompts.outro("Database reset refused; the reset marker remains for recovery");
        return RESET_DB_EXIT.refused;
    }
    rmSync(databaseResetMarkerPath(dbPath), { force: true });
    prompts.log.info(
        "No file had been quarantined; the reset marker was rolled back and the family is unchanged.",
    );
    const now = inspectDirectDatabaseFamilyState(dbPath);
    if (now.state === "current") {
        prompts.log.info(
            "The database family is now the current supported format and was preserved unchanged.",
        );
    }
    prompts.outro("Database reset refused");
    return RESET_DB_EXIT.refused;
}

function executeQuarantine(
    prompts: PromptIO,
    deps: ResetDbDeps,
    storageDir: string,
    dbPath: string,
    marker: DatabaseResetMarker,
): ResetDbExitCode {
    for (const role of DATABASE_FAMILY_MOVE_ORDER) {
        const verification = verifyResetMarkerFamily(marker);
        if (verification.problems.length > 0) {
            return refuseQuarantine(prompts, dbPath, marker, verification, {
                problems: verification.problems,
            });
        }
        const holders = deps.inspectHolders(storageDir);
        if (!holders.safe) {
            return refuseQuarantine(prompts, dbPath, marker, verification, { holders });
        }
        const fileCheck = verification.files.find((file) => file.role === role);
        if (!fileCheck) continue;
        if (fileCheck.status === "moved") {
            prompts.log.info(`Already quarantined ${role}; resuming.`);
            continue;
        }
        const destination = moveIntoQuarantine(
            databaseFamilyFilePath(dbPath, role),
            marker.quarantineDirPath,
        );
        prompts.log.info(`Quarantined ${role}: ${destination}`);
    }
    const markerDestination = moveIntoQuarantine(
        databaseResetMarkerPath(dbPath),
        marker.quarantineDirPath,
    );
    prompts.log.info(`Reset marker finalized into quarantine: ${markerDestination}`);
    prompts.log.success(`Database family quarantined: ${marker.quarantineDirPath}`);
    prompts.log.info(RETENTION_NOTE);
    prompts.log.info(
        "The next supported open will bootstrap a fresh database with a new database incarnation.",
    );
    prompts.outro("Database reset complete");
    return RESET_DB_EXIT.ok;
}

async function confirmReset(
    prompts: PromptIO,
    options: RunResetDbOptions,
    message: string,
): Promise<boolean> {
    if (options.yes) return true;
    return prompts.confirm(message, false);
}

async function recoverPendingReset(
    prompts: PromptIO,
    deps: ResetDbDeps,
    storageDir: string,
    dbPath: string,
    markerRead:
        | { readonly status: "present"; readonly marker: DatabaseResetMarker }
        | { readonly status: "malformed"; readonly reason: string },
    options: RunResetDbOptions,
): Promise<ResetDbExitCode> {
    if (markerRead.status === "malformed") {
        prompts.log.error(`A reset marker exists but is unreadable: ${markerRead.reason}`);
        prompts.log.info(
            `Marker: ${databaseResetMarkerPath(dbPath)}. Nothing was changed. Inspect the marker and any quarantine directory beside it manually before removing the marker.`,
        );
        prompts.outro("Database reset recovery failed");
        return RESET_DB_EXIT.failed;
    }
    const marker = markerRead.marker;
    const verification = verifyResetMarkerFamily(marker);
    prompts.log.info(
        `An interrupted reset is pending (marker created ${new Date(marker.createdAtMs).toISOString()}).`,
    );
    prompts.log.info(
        `Database incarnation: ${marker.databaseIncarnationId ?? "none readable from this family"}`,
    );
    prompts.log.info(`Quarantine destination: ${marker.quarantineDirPath}`);
    for (const file of verification.files) {
        prompts.log.info(`  ${file.role}: ${file.status}`);
    }
    prompts.log.info(RETENTION_NOTE);
    if (options.dryRun) {
        prompts.log.info("Dry run: no file was changed.");
        prompts.outro("Database reset preview complete");
        return RESET_DB_EXIT.ok;
    }
    const confirmed = await confirmReset(
        prompts,
        options,
        "Complete the interrupted reset now? Remaining family files will be abandoned into quarantine.",
    );
    if (!confirmed) {
        prompts.log.info("Reset declined. The pending reset marker remains in place.");
        prompts.outro("Database reset declined");
        return RESET_DB_EXIT.declined;
    }
    return executeQuarantine(prompts, deps, storageDir, dbPath, marker);
}

function printHelp(): void {
    console.log("Usage: magic-context doctor reset-db [--dry-run] [--yes] [--db <path>]");
    console.log("");
    console.log("Abandon an unsupported context.db family into a private quarantine directory.");
    console.log("Reset never migrates or salvages data and never touches a supported database.");
    console.log("");
    console.log("  --dry-run   Preview the family, file identities, and destination only");
    console.log("  --yes       Skip the interactive confirmation");
    console.log("  --db <path> Operate on an explicit database path");
}

export async function runResetDb(options: RunResetDbOptions = {}): Promise<ResetDbExitCode> {
    const prompts = options.prompts ?? promptIO;
    const deps: ResetDbDeps = { ...DEFAULT_DEPS, ...options.deps };
    const storageDir =
        options.storageDir ??
        dirname(options.dbPath ?? join(getMagicContextStorageDir(), "context.db"));
    const dbPath = options.dbPath ?? join(storageDir, "context.db");

    prompts.intro("Magic Context — Reset unsupported database");
    prompts.log.info(`Database: ${dbPath}`);

    const state = inspectDirectDatabaseFamilyState(dbPath);
    prompts.log.info(`State: ${describeFamilyState(state)}`);

    if (state.state === "reset-pending") {
        return recoverPendingReset(prompts, deps, storageDir, dbPath, state.marker, options);
    }
    if (state.state === "pristine") {
        prompts.log.info("Nothing to reset: no database family exists at this path.");
        prompts.outro("Database reset not needed");
        return RESET_DB_EXIT.ok;
    }
    if (state.state === "current") {
        prompts.log.error(
            "Refusing to reset: this database is the current supported format. Reset abandons only unsupported families.",
        );
        prompts.outro("Database reset refused");
        return RESET_DB_EXIT.refused;
    }

    const identities = captureDatabaseFamilyIdentities(dbPath);
    const quarantineDirPath = allocateQuarantineDirPath(dbPath, timestamp(deps.now()));
    const databaseIncarnationId =
        state.state === "unsupported" ? state.databaseIncarnationId : null;
    reportPlan(
        prompts,
        dbPath,
        describeFamilyState(state),
        state.state === "unsupported" ? state.reasons : [],
        databaseIncarnationId,
        identities,
        quarantineDirPath,
    );

    if (options.dryRun) {
        prompts.log.info("Dry run: no file was changed and no reset marker was published.");
        prompts.outro("Database reset preview complete");
        return RESET_DB_EXIT.ok;
    }

    const initialInspection = deps.inspectHolders(storageDir);
    if (!initialInspection.safe) {
        reportSafetyRefusal(prompts, dbPath, initialInspection);
        prompts.outro("Database reset refused; the database family was not modified");
        return RESET_DB_EXIT.refused;
    }

    const confirmed = await confirmReset(
        prompts,
        options,
        "Abandon this database family into quarantine? All of its logical data will be lost to the application.",
    );
    if (!confirmed) {
        prompts.log.info("Reset declined. The database family remains in place.");
        prompts.outro("Database reset declined");
        return RESET_DB_EXIT.declined;
    }

    const marker = buildDatabaseResetMarker({
        dbPath,
        createdAtMs: deps.now().getTime(),
        databaseIncarnationId,
        quarantineDirPath,
        fileIdentities: identities,
    });
    try {
        writeDatabaseResetMarker(marker);
    } catch (error) {
        prompts.log.error(
            `Could not publish the reset marker: ${error instanceof Error ? error.message : String(error)}`,
        );
        prompts.outro("Database reset failed before any file was moved");
        return RESET_DB_EXIT.failed;
    }
    prompts.log.info(`Reset marker published: ${databaseResetMarkerPath(dbPath)}`);
    return executeQuarantine(prompts, deps, storageDir, dbPath, marker);
}

export async function runResetDbCli(
    args: string[],
    options: RunResetDbOptions = {},
): Promise<ResetDbExitCode> {
    if (args.includes("--help") || args.includes("-h")) {
        printHelp();
        return RESET_DB_EXIT.ok;
    }
    const dbIndex = args.indexOf("--db");
    const dbPath = dbIndex === -1 ? null : args[dbIndex + 1];
    if (dbIndex !== -1 && (!dbPath || dbPath.startsWith("--"))) {
        throw new Error("--db requires a value");
    }
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--db") {
            index += 1;
            continue;
        }
        if (arg === "--dry-run" || arg === "--yes") continue;
        throw new Error(`Unknown doctor reset-db option: ${arg}`);
    }
    return runResetDb({
        ...options,
        dryRun: args.includes("--dry-run"),
        yes: args.includes("--yes"),
        ...(dbPath ? { dbPath } : {}),
    });
}
