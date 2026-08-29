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
 *
 * The format classification this command acts on — and reports to the operator
 * for confirmation — is the one taken after the first holder inspection finds
 * no live holder. An earlier reading can be torn by a writer checkpointing
 * mid-probe, which would otherwise quarantine a supported database.
 */
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
    readDatabaseResetMarker,
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
    inspectFamilyState: (dbPath: string) => DirectDatabaseFamilyState;
    renameFile: typeof renameSync;
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
    inspectFamilyState: inspectDirectDatabaseFamilyState,
    renameFile: renameSync,
};

const RETENTION_NOTE =
    "Quarantine is logical abandonment, not secure erasure; the quarantined files are retained at that path until you delete them yourself.";

function timestamp(date: Date): string {
    return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
}

function pathEntryExists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code?: unknown }).code === "ENOENT"
        ) {
            return false;
        }
        throw error;
    }
}

function allocateQuarantineDirPath(dbPath: string, stamp: string): string {
    const preferred = `${dbPath}${DATABASE_QUARANTINE_DIR_INFIX}${stamp}`;
    if (!pathEntryExists(preferred)) return preferred;
    for (let attempt = 1; attempt < 10_000; attempt++) {
        const candidate = `${preferred}-${attempt}`;
        if (!pathEntryExists(candidate)) return candidate;
    }
    throw new Error(`Could not allocate a unique quarantine path beside ${dbPath}`);
}

function ensureQuarantineDir(path: string): void {
    if (!pathEntryExists(path)) {
        try {
            mkdirSync(path, { mode: 0o700 });
        } catch (error) {
            if (!pathEntryExists(path)) throw error;
        }
    }
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`quarantine path is not a private directory: ${path}`);
    }
    chmodSync(path, 0o700);
}

function moveIntoQuarantine(
    sourcePath: string,
    quarantineDirPath: string,
    renameFile: typeof renameSync,
    restrictAfterMove = true,
): string {
    ensureQuarantineDir(quarantineDirPath);
    const destination = join(quarantineDirPath, basename(sourcePath));
    if (pathEntryExists(destination)) {
        throw new Error(`quarantine destination already exists: ${destination}`);
    }
    renameFile(sourcePath, destination);
    if (restrictAfterMove) chmodSync(destination, 0o600);
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
            return `${state.format === "direct" ? "corrupt direct format" : "corrupt unknown format"} (${state.detail})`;
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
    deps: ResetDbDeps,
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
    if (verification.anyMoved || !verification.inspectionComplete) {
        prompts.log.info(
            `The interrupted quarantine remains pending at ${marker.quarantineDirPath}; re-run \`${DATABASE_RESET_COMMAND}\` once the blocker is resolved.`,
        );
        prompts.outro("Database reset refused; the reset marker remains for recovery");
        return RESET_DB_EXIT.refused;
    }
    const markerRead = readDatabaseResetMarker(dbPath);
    if (markerRead.status !== "present" || markerRead.marker.markerDigest !== marker.markerDigest) {
        prompts.log.error("Reset marker identity changed; refusing to remove it during rollback.");
        prompts.outro("Database reset refused; inspect the reset marker manually");
        return RESET_DB_EXIT.refused;
    }
    try {
        rmSync(databaseResetMarkerPath(dbPath));
    } catch (error) {
        prompts.log.error(
            `Could not roll back the reset marker: ${error instanceof Error ? error.message : String(error)}`,
        );
        prompts.outro("Database reset refused; the reset marker remains for recovery");
        return RESET_DB_EXIT.refused;
    }
    prompts.log.info(
        "No file had been quarantined; the reset marker was rolled back and the family is unchanged.",
    );
    const now = deps.inspectFamilyState(dbPath);
    if (now.state === "current") {
        prompts.log.info(
            "The database family is now the current supported format and was preserved unchanged.",
        );
    }
    prompts.outro("Database reset refused");
    return RESET_DB_EXIT.refused;
}

function reportInterruptedMove(
    prompts: PromptIO,
    marker: DatabaseResetMarker,
    role: string,
    error: unknown,
): ResetDbExitCode {
    prompts.log.error(
        `Could not quarantine ${role}: ${error instanceof Error ? error.message : String(error)}`,
    );
    prompts.log.info(
        `The reset marker remains at ${databaseResetMarkerPath(marker.dbPath)}. Re-run \`${DATABASE_RESET_COMMAND}\` to resume the interrupted quarantine at ${marker.quarantineDirPath}.`,
    );
    prompts.outro("Database reset interrupted; recovery remains pending");
    return RESET_DB_EXIT.failed;
}

function inspectHoldersSafely(deps: ResetDbDeps, storageDir: string): DatabaseHolderInspection {
    try {
        return deps.inspectHolders(storageDir);
    } catch (error) {
        return {
            safe: false,
            blockers: [],
            uncertainty: `Database holder inspection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

function executeQuarantine(
    prompts: PromptIO,
    deps: ResetDbDeps,
    storageDir: string,
    dbPath: string,
    marker: DatabaseResetMarker,
): ResetDbExitCode {
    for (const role of DATABASE_FAMILY_MOVE_ORDER) {
        const holders = inspectHoldersSafely(deps, storageDir);
        const verification = verifyResetMarkerFamily(marker);
        if (!holders.safe) {
            return refuseQuarantine(prompts, deps, dbPath, marker, verification, { holders });
        }
        if (verification.problems.length > 0) {
            return refuseQuarantine(prompts, deps, dbPath, marker, verification, {
                problems: verification.problems,
            });
        }
        const fileCheck = verification.files.find((file) => file.role === role);
        if (!fileCheck) continue;
        const destination = join(
            marker.quarantineDirPath,
            basename(databaseFamilyFilePath(dbPath, role)),
        );
        if (fileCheck.status === "moved") {
            try {
                ensureQuarantineDir(marker.quarantineDirPath);
                chmodSync(destination, 0o600);
            } catch (error) {
                return reportInterruptedMove(prompts, marker, role, error);
            }
            prompts.log.info(`Already quarantined ${role}; resuming.`);
            continue;
        }
        try {
            moveIntoQuarantine(
                databaseFamilyFilePath(dbPath, role),
                marker.quarantineDirPath,
                deps.renameFile,
            );
        } catch (error) {
            return reportInterruptedMove(prompts, marker, role, error);
        }
        prompts.log.info(`Quarantined ${role}: ${destination}`);
    }

    const holders = inspectHoldersSafely(deps, storageDir);
    const verification = verifyResetMarkerFamily(marker);
    if (!holders.safe) {
        return refuseQuarantine(prompts, deps, dbPath, marker, verification, { holders });
    }
    if (verification.problems.length > 0) {
        return refuseQuarantine(prompts, deps, dbPath, marker, verification, {
            problems: verification.problems,
        });
    }
    const markerRead = readDatabaseResetMarker(dbPath);
    if (markerRead.status !== "present" || markerRead.marker.markerDigest !== marker.markerDigest) {
        return reportInterruptedMove(
            prompts,
            marker,
            "reset marker",
            new Error("reset marker identity changed before finalization"),
        );
    }
    let markerDestination: string;
    try {
        chmodSync(databaseResetMarkerPath(dbPath), 0o600);
        markerDestination = moveIntoQuarantine(
            databaseResetMarkerPath(dbPath),
            marker.quarantineDirPath,
            deps.renameFile,
            false,
        );
    } catch (error) {
        return reportInterruptedMove(prompts, marker, "reset marker", error);
    }
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

/** The two family states reset may abandon; every other state exits early. */
type ResettableFamilyState = Extract<
    DirectDatabaseFamilyState,
    { state: "unsupported" } | { state: "corrupt" }
>;

interface ResetPlan {
    readonly identities: DatabaseFileIdentity[];
    readonly quarantineDirPath: string;
}

function familyIncarnation(state: ResettableFamilyState): string | null {
    return state.state === "unsupported" ? state.databaseIncarnationId : null;
}

/** Null once the failure has been reported; the caller exits `failed`. */
function captureResetPlan(prompts: PromptIO, deps: ResetDbDeps, dbPath: string): ResetPlan | null {
    try {
        return {
            identities: captureDatabaseFamilyIdentities(dbPath),
            quarantineDirPath: allocateQuarantineDirPath(dbPath, timestamp(deps.now())),
        };
    } catch (error) {
        prompts.log.error(
            `Could not inspect the database family safely: ${error instanceof Error ? error.message : String(error)}`,
        );
        prompts.outro("Database reset failed before any file was changed");
        return null;
    }
}

function reportResetPlan(
    prompts: PromptIO,
    dbPath: string,
    state: ResettableFamilyState,
    plan: ResetPlan,
): void {
    reportPlan(
        prompts,
        dbPath,
        describeFamilyState(state),
        state.state === "unsupported" ? state.reasons : [],
        familyIncarnation(state),
        plan.identities,
        plan.quarantineDirPath,
    );
}

type ExclusivityRecheck =
    | { readonly outcome: "resettable"; readonly state: ResettableFamilyState }
    | { readonly outcome: "stop"; readonly code: ResetDbExitCode };

/**
 * Re-classify the family now that the holder inspection found no live holder.
 *
 * The first classification can be taken while a writer is still active, and it
 * reads a probe copy whose main file and sidecars are copied as separate
 * operations — so a checkpoint landing between those copies makes a supported
 * family read as unsupported or corrupt. That reading is inherently racy; one
 * taken after the holder inspection is not. The later reading is therefore the
 * one this command acts on, and the plan reported to the operator below (the
 * text the confirmation prompt refers to) is built from it, so confirmation
 * and quarantine can never describe different classifications.
 *
 * The re-check itself cannot damage the family: classification only reads
 * pragmas and schema from a private throwaway copy.
 */
function recheckUnderExclusivity(
    prompts: PromptIO,
    deps: ResetDbDeps,
    dbPath: string,
    reported: ResettableFamilyState,
): ExclusivityRecheck {
    const state = deps.inspectFamilyState(dbPath);
    if (state.state === "current") {
        prompts.log.error(
            `Refusing to reset: re-checked with no database holder present, this family is the current supported format (database incarnation ${state.databaseIncarnationId}). The earlier "${describeFamilyState(reported)}" reading was taken while the family could still change.`,
        );
        prompts.log.info("Nothing was changed and no reset marker was published.");
        prompts.outro("Database reset refused");
        return { outcome: "stop", code: RESET_DB_EXIT.refused };
    }
    if (state.state === "pristine") {
        prompts.log.info(
            "Nothing to reset: re-checked with no database holder present, no database family exists at this path.",
        );
        prompts.outro("Database reset not needed");
        return { outcome: "stop", code: RESET_DB_EXIT.ok };
    }
    if (state.state === "reset-pending") {
        prompts.log.error(
            "Refusing to reset: another reset published a marker for this family while this one was preparing.",
        );
        prompts.log.info(
            `Marker: ${databaseResetMarkerPath(dbPath)}. Nothing was changed. Re-run \`${DATABASE_RESET_COMMAND}\` to inspect that reset and complete or roll it back.`,
        );
        prompts.outro("Database reset refused");
        return { outcome: "stop", code: RESET_DB_EXIT.refused };
    }
    if (describeFamilyState(state) !== describeFamilyState(reported)) {
        prompts.log.warn(
            `Re-checked with no database holder present: ${describeFamilyState(state)}. Acting on this reading, not the earlier one.`,
        );
    }
    return { outcome: "resettable", state };
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
    reportIdentities(prompts, marker.fileIdentities, dbPath);
    prompts.log.info(`Quarantine destination: ${marker.quarantineDirPath}`);
    for (const file of verification.files) {
        prompts.log.info(`  recovery ${file.role}: ${file.status}`);
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
    const requestedDbPath =
        options.dbPath ?? join(options.storageDir ?? getMagicContextStorageDir(), "context.db");
    const dbPath = resolve(requestedDbPath);
    const storageDir = resolve(options.storageDir ?? dirname(dbPath));

    prompts.intro("Magic Context — Reset unsupported database");
    prompts.log.info(`Database: ${dbPath}`);

    const state = deps.inspectFamilyState(dbPath);
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

    if (options.dryRun) {
        const preview = captureResetPlan(prompts, deps, dbPath);
        if (preview === null) return RESET_DB_EXIT.failed;
        reportResetPlan(prompts, dbPath, state, preview);
        prompts.log.info("Dry run: no file was changed and no reset marker was published.");
        prompts.outro("Database reset preview complete");
        return RESET_DB_EXIT.ok;
    }

    const initialInspection = inspectHoldersSafely(deps, storageDir);
    if (!initialInspection.safe) {
        reportSafetyRefusal(prompts, dbPath, initialInspection);
        prompts.outro("Database reset refused; the database family was not modified");
        return RESET_DB_EXIT.refused;
    }

    const recheck = recheckUnderExclusivity(prompts, deps, dbPath, state);
    if (recheck.outcome === "stop") return recheck.code;
    const confirmedState = recheck.state;

    const plan = captureResetPlan(prompts, deps, dbPath);
    if (plan === null) return RESET_DB_EXIT.failed;
    reportResetPlan(prompts, dbPath, confirmedState, plan);

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

    // The confirmation prompt is an open-ended window: another process can
    // upgrade or replace the family in place and exit while it is displayed, and
    // the holder check afterwards would see nobody. Publishing from the
    // pre-prompt reading would then bind a marker to a family that no longer
    // matches it, and because marker verification compares device and inode
    // while deliberately ignoring size and content, an in-place replacement that
    // reuses the inode can still pass — quarantining a now-current family. So
    // reclassify and recapture immediately before publishing and act on that
    // reading, not the one the user was shown.
    const postConfirmRecheck = recheckUnderExclusivity(prompts, deps, dbPath, confirmedState);
    if (postConfirmRecheck.outcome === "stop") return postConfirmRecheck.code;
    const publishState = postConfirmRecheck.state;
    const publishPlan = captureResetPlan(prompts, deps, dbPath);
    if (publishPlan === null) return RESET_DB_EXIT.failed;

    const marker = buildDatabaseResetMarker({
        dbPath,
        createdAtMs: deps.now().getTime(),
        databaseIncarnationId: familyIncarnation(publishState),
        quarantineDirPath: publishPlan.quarantineDirPath,
        fileIdentities: publishPlan.identities,
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
