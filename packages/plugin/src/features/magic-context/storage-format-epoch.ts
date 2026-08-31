/**
 *
 * `PRAGMA application_id` uses `MC_APPLICATION_ID` (`"MCTX"`).
 * `PRAGMA user_version` uses `DIRECT_FORMAT_EPOCH`.
 * `mc_format_marker` contains one immutable row binding the format epoch, database-incarnation ID, component-manifest digest, and marker digest.
 *
 */

import { createHash, randomBytes } from "node:crypto";
import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    openSync,
    readFileSync,
    type Stats,
    unlinkSync,
    writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Database } from "../../shared/sqlite";

/** `MC_APPLICATION_ID` stores the ASCII value `"MCTX"` for `PRAGMA application_id` in the direct format. */
export const MC_APPLICATION_ID = 0x4d435458;

/**
 * `DIRECT_FORMAT_EPOCH` is nonzero because the legacy migration lane leaves `user_version` at 0; increment it only for breaking format changes.
 */
export const DIRECT_FORMAT_EPOCH = 1;

export const DIRECT_FORMAT_MARKER_TABLE = "mc_format_marker";

/* */
export const FORMAT_MARKER_DIGEST_PROTOCOL = "mc-direct-format-marker-v1";

/**
 * Classification rejects database families containing a `.mc-reset` sidecar.
 * reset artifact.
 */
export const DATABASE_RESET_MARKER_SUFFIX = ".mc-reset";

export interface DirectFormatMarker {
    readonly formatEpoch: number;
    /** `databaseIncarnationId` stores a 128-bit random identity as 32 lowercase hexadecimal characters and remains immutable for the file's lifetime. */
    readonly databaseIncarnationId: string;
    /** `componentManifestDigest` stores the SHA-256 hexadecimal digest of the registered-component manifest. */
    readonly componentManifestDigest: string;
    readonly createdAtMs: number;
    /* */
    readonly markerDigest: string;
}

const INCARNATION_ID_PATTERN = /^[0-9a-f]{32}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/* */
export function generateDatabaseIncarnationId(
    random: (byteCount: number) => Uint8Array = randomBytes,
): string {
    return Buffer.from(random(16)).toString("hex");
}

export function isValidDatabaseIncarnationId(candidate: string): boolean {
    return INCARNATION_ID_PATTERN.test(candidate);
}

/**
 */
export function canonicalMarkerDigestLines(
    marker: Omit<DirectFormatMarker, "markerDigest">,
    applicationId: number = MC_APPLICATION_ID,
): string[] {
    return [
        FORMAT_MARKER_DIGEST_PROTOCOL,
        `application_id=${applicationId}`,
        `format_epoch=${marker.formatEpoch}`,
        `database_incarnation_id=${marker.databaseIncarnationId}`,
        `component_manifest_digest=${marker.componentManifestDigest}`,
        `created_at_ms=${marker.createdAtMs}`,
    ];
}

export function computeMarkerDigest(
    marker: Omit<DirectFormatMarker, "markerDigest">,
    applicationId: number = MC_APPLICATION_ID,
): string {
    return createHash("sha256")
        .update(canonicalMarkerDigestLines(marker, applicationId).join("\n"), "utf8")
        .digest("hex");
}

export function buildDirectFormatMarker(input: {
    componentManifestDigest: string;
    createdAtMs: number;
    databaseIncarnationId?: string;
    formatEpoch?: number;
}): DirectFormatMarker {
    const withoutDigest = {
        formatEpoch: input.formatEpoch ?? DIRECT_FORMAT_EPOCH,
        databaseIncarnationId: input.databaseIncarnationId ?? generateDatabaseIncarnationId(),
        componentManifestDigest: input.componentManifestDigest,
        createdAtMs: input.createdAtMs,
    };
    if (!isValidDatabaseIncarnationId(withoutDigest.databaseIncarnationId)) {
        throw new Error(`invalid database incarnation ID: ${withoutDigest.databaseIncarnationId}`);
    }
    return { ...withoutDigest, markerDigest: computeMarkerDigest(withoutDigest) };
}

/**
 * `mc_format_marker` permits only `id = 1`; UPDATE and DELETE raise, so the bootstrap incarnation persists for the file's lifetime.
 */
export function createDirectFormatMarkerSchema(db: Database): void {
    // pi-lens-ignore: sql-injection
    db.exec(`
    CREATE TABLE ${DIRECT_FORMAT_MARKER_TABLE} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        format_epoch INTEGER NOT NULL,
        database_incarnation_id TEXT NOT NULL CHECK (length(database_incarnation_id) = 32),
        component_manifest_digest TEXT NOT NULL CHECK (length(component_manifest_digest) = 64),
        created_at_ms INTEGER NOT NULL,
        marker_digest TEXT NOT NULL CHECK (length(marker_digest) = 64)
    );
    CREATE TRIGGER ${DIRECT_FORMAT_MARKER_TABLE}_no_update
    BEFORE UPDATE ON ${DIRECT_FORMAT_MARKER_TABLE} BEGIN
        SELECT RAISE(ABORT, '${DIRECT_FORMAT_MARKER_TABLE} is immutable');
    END;
    CREATE TRIGGER ${DIRECT_FORMAT_MARKER_TABLE}_no_delete
    BEFORE DELETE ON ${DIRECT_FORMAT_MARKER_TABLE} BEGIN
        SELECT RAISE(ABORT, '${DIRECT_FORMAT_MARKER_TABLE} is immutable');
    END;
    `);
}

/* */
export function stampDirectFormatMarker(db: Database, marker: DirectFormatMarker): void {
    if (!Number.isSafeInteger(marker.formatEpoch) || marker.formatEpoch < 1) {
        throw new Error(`invalid format epoch: ${marker.formatEpoch}`);
    }
    // PRAGMA cannot take bound parameters; the epoch is integer-validated above.
    // pi-lens-ignore: sql-injection
    db.exec(`PRAGMA application_id = ${MC_APPLICATION_ID}`);
    // pi-lens-ignore: sql-injection
    db.exec(`PRAGMA user_version = ${marker.formatEpoch}`);
    db.prepare(
        `INSERT INTO ${DIRECT_FORMAT_MARKER_TABLE}
            (id, format_epoch, database_incarnation_id, component_manifest_digest, created_at_ms, marker_digest)
         VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(
        marker.formatEpoch,
        marker.databaseIncarnationId,
        marker.componentManifestDigest,
        marker.createdAtMs,
        marker.markerDigest,
    );
}

export type DirectFormatMarkerRead =
    | { status: "absent" }
    | { status: "malformed"; reason: string }
    | { status: "present"; marker: DirectFormatMarker };

/* */
export function readDirectFormatMarker(db: Database): DirectFormatMarkerRead {
    const tablePresent = db
        .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ?")
        .get(DIRECT_FORMAT_MARKER_TABLE);
    if (!tablePresent) return { status: "absent" };
    let rows: Array<Record<string, unknown>>;
    try {
        rows = db
            .prepare(
                `SELECT format_epoch, database_incarnation_id, component_manifest_digest, created_at_ms, marker_digest FROM ${DIRECT_FORMAT_MARKER_TABLE}`,
            )
            .all() as Array<Record<string, unknown>>;
    } catch (error) {
        return {
            status: "malformed",
            reason: `marker table is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (rows.length === 0) return { status: "malformed", reason: "marker table has no row" };
    if (rows.length > 1) {
        return { status: "malformed", reason: `marker table has ${rows.length} rows` };
    }
    const row = rows[0];
    const withoutDigest = {
        formatEpoch: Number(row.format_epoch),
        databaseIncarnationId: String(row.database_incarnation_id ?? ""),
        componentManifestDigest: String(row.component_manifest_digest ?? ""),
        createdAtMs: Number(row.created_at_ms),
    };
    const storedDigest = String(row.marker_digest ?? "");
    if (!Number.isSafeInteger(withoutDigest.formatEpoch) || withoutDigest.formatEpoch < 1) {
        return {
            status: "malformed",
            reason: `marker format epoch is invalid: ${row.format_epoch}`,
        };
    }
    if (!isValidDatabaseIncarnationId(withoutDigest.databaseIncarnationId)) {
        return { status: "malformed", reason: "marker database incarnation ID is invalid" };
    }
    if (!SHA256_HEX_PATTERN.test(withoutDigest.componentManifestDigest)) {
        return { status: "malformed", reason: "marker component manifest digest is invalid" };
    }
    if (!Number.isSafeInteger(withoutDigest.createdAtMs)) {
        return { status: "malformed", reason: "marker creation time is invalid" };
    }
    if (computeMarkerDigest(withoutDigest) !== storedDigest) {
        return { status: "malformed", reason: "marker digest mismatch" };
    }
    return { status: "present", marker: { ...withoutDigest, markerDigest: storedDigest } };
}

// ---------------------------------------------------------------------------
// The classifier consumes KTD1 state-machine inputs without I/O.
// ---------------------------------------------------------------------------

export type DatabaseFormatFamily =
    | "current"
    | "pristine"
    | "unsupported"
    | "malformed-marker"
    | "orphan-artifacts";

/** Artifact inspection gathers KTD1 inputs; classification is pure. */
export interface FormatFamilyInspection {
    readonly mainFileExists: boolean;
    readonly applicationId: number;
    readonly userVersion: number;
    /* */
    readonly schemaObjectNames: readonly string[];
    readonly marker: DirectFormatMarkerRead;
    /** The artifact set includes on-disk sidecar, journal, and reset artifacts. */
    readonly artifacts: readonly string[];
}

/* */
export interface ExpectedDirectFormat {
    readonly applicationId: number;
    readonly formatEpoch: number;
    readonly componentManifestDigest: string;
    /** The classifier requires an exact object inventory, including marker objects. */
    readonly schemaObjectNames: readonly string[];
}

export interface FormatFamilyClassification {
    readonly family: DatabaseFormatFamily;
    readonly reasons: readonly string[];
}

function isBareSqliteFamily(inspection: FormatFamilyInspection): boolean {
    return (
        inspection.schemaObjectNames.length === 0 &&
        inspection.applicationId === 0 &&
        inspection.userVersion === 0 &&
        inspection.marker.status === "absent"
    );
}

/**
 * The classifier accepts only exact current registered formats and pristine families; it refuses every other family state without changes.
 */
export function classifyDatabaseFormatFamily(
    inspection: FormatFamilyInspection,
    expected: ExpectedDirectFormat,
): FormatFamilyClassification {
    if (inspection.marker.status === "malformed") {
        return { family: "malformed-marker", reasons: [inspection.marker.reason] };
    }

    if (!inspection.mainFileExists || isBareSqliteFamily(inspection)) {
        if (inspection.artifacts.length > 0) {
            return {
                family: "orphan-artifacts",
                reasons: inspection.artifacts.map(
                    (artifact) => `orphan ${artifact} artifact without a current main database`,
                ),
            };
        }
        return { family: "pristine", reasons: [] };
    }

    const reasons: string[] = [];
    if (inspection.marker.status === "absent") {
        reasons.push("direct-format marker is absent");
    } else {
        const marker = inspection.marker.marker;
        if (marker.formatEpoch !== expected.formatEpoch) {
            reasons.push(
                `marker format epoch ${marker.formatEpoch} does not match expected ${expected.formatEpoch}`,
            );
        }
        if (marker.componentManifestDigest !== expected.componentManifestDigest) {
            reasons.push("marker component manifest digest does not match this build's manifest");
        }
    }
    if (inspection.applicationId !== expected.applicationId) {
        reasons.push(
            `application_id ${inspection.applicationId} does not match expected ${expected.applicationId}`,
        );
    }
    if (inspection.userVersion !== expected.formatEpoch) {
        reasons.push(
            `user_version ${inspection.userVersion} does not match expected format epoch ${expected.formatEpoch}`,
        );
    }
    const actual = new Set(inspection.schemaObjectNames);
    const expectedSet = new Set(expected.schemaObjectNames);
    for (const name of expectedSet) {
        if (!actual.has(name)) reasons.push(`missing registered schema object: ${name}`);
    }
    for (const name of actual) {
        if (!expectedSet.has(name)) reasons.push(`unregistered schema object: ${name}`);
    }
    if (inspection.artifacts.includes("reset-marker")) {
        reasons.push("a pending reset marker exists for this database family");
    }
    if (reasons.length === 0) return { family: "current", reasons: [] };
    return { family: "unsupported", reasons };
}

/* */
export function listDatabaseFamilyArtifacts(
    dbPath: string,
    exists: (path: string) => boolean = existsSync,
): string[] {
    const artifacts: string[] = [];
    if (exists(`${dbPath}-wal`)) artifacts.push("wal");
    if (exists(`${dbPath}-shm`)) artifacts.push("shm");
    if (exists(`${dbPath}-journal`)) artifacts.push("journal");
    if (exists(`${dbPath}${DATABASE_RESET_MARKER_SUFFIX}`)) artifacts.push("reset-marker");
    return artifacts;
}

/** The pre-open gate records an artifact-only decision without opening SQLite. */
export type PreOpenFamilyVerdict =
    | { readonly decision: "open" }
    | {
          readonly decision: "refuse";
          readonly family: "reset-pending" | "unsupported" | "orphan-artifacts";
          readonly reasons: readonly string[];
      };

/** Artifact inspection gathers the disk-only facts that the pre-open gate classifies. */
export interface PreOpenFamilyInput {
    readonly artifacts: readonly string[];
    readonly mainFileExists: boolean;
    readonly mainFileSize: number;
}

/**
 * The pre-open gate decides from disk artifacts before SQLite opens, preventing recovery from consuming an orphan WAL or rolling back an unclassified family.
 *
 * The classifier treats a missing or zero-length main file with `-journal` under the write lock as a concurrent or interrupted DELETE-mode bootstrap; it treats a journal beside a nonempty main file as terminal.
 */
export function classifyPreOpenFamily(
    dbPath: string,
    input: PreOpenFamilyInput,
): PreOpenFamilyVerdict {
    if (input.artifacts.includes("reset-marker")) {
        return {
            decision: "refuse",
            family: "reset-pending",
            reasons: [
                `a reset marker ${databaseResetMarkerPath(dbPath)} is pending for this database family`,
            ],
        };
    }
    const mainHasContent = input.mainFileExists && input.mainFileSize > 0;
    if (input.artifacts.includes("journal")) {
        if (mainHasContent) {
            return {
                decision: "refuse",
                family: "unsupported",
                reasons: [
                    `a pre-existing rollback journal ${databaseFamilyFilePath(dbPath, "rollback-journal")} must be refused before SQLite open-time recovery`,
                ],
            };
        }
        // The classifier treats a WAL with an empty main file as an orphan because DELETE-mode bootstrap never produces one.
        if (!input.artifacts.includes("wal")) return { decision: "open" };
    }
    if (mainHasContent) return { decision: "open" };
    if (input.artifacts.length === 0) return { decision: "open" };
    return {
        decision: "refuse",
        family: "orphan-artifacts",
        reasons: input.artifacts.map(
            (artifact) => `orphan ${artifact} artifact without a current main database`,
        ),
    };
}

// ---------------------------------------------------------------------------
//
// An explicit reset publishes an interruption-safe private marker file
// The marker is published before the final holder inspection and binds to the database incarnation and dev/inode identities of every family file.
// Moving the marker last makes its presence proof that the family files entered quarantine.
// A source-path marker means reset pending.
// A source-path marker means reset pending, and `reset-marker` classification refuses the family.
// `reset-marker` classification blocks pristine bootstrap.
// Pristine bootstrap remains blocked until recovery resumes or rolls back the quarantine.
// ---------------------------------------------------------------------------

/** The protocol tag identifies the canonical reset-marker digest format. */
export const RESET_MARKER_PROTOCOL = "mc-database-reset-marker-v1";

/* */
export const DATABASE_QUARANTINE_DIR_INFIX = ".mc-quarantine-";

export type DatabaseFamilyFileRole = "rollback-journal" | "wal" | "shm" | "main";

/* */
export const DATABASE_FAMILY_MOVE_ORDER: readonly DatabaseFamilyFileRole[] = [
    "rollback-journal",
    "wal",
    "shm",
    "main",
];

const FAMILY_FILE_SUFFIXES: Record<DatabaseFamilyFileRole, string> = {
    main: "",
    wal: "-wal",
    shm: "-shm",
    "rollback-journal": "-journal",
};

export function databaseFamilyFilePath(dbPath: string, role: DatabaseFamilyFileRole): string {
    return `${dbPath}${FAMILY_FILE_SUFFIXES[role]}`;
}

export function databaseResetMarkerPath(dbPath: string): string {
    return `${dbPath}${DATABASE_RESET_MARKER_SUFFIX}`;
}

/** Each `DatabaseFileIdentity` records a family file's dev/inode identity at marker publication. */
export interface DatabaseFileIdentity {
    readonly role: DatabaseFamilyFileRole;
    readonly dev: number;
    readonly ino: number;
    /** `sizeBytes` provides logical-data-loss context and is never used for identity checks. */
    readonly sizeBytes: number;
}

function isMissingPathError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
    );
}

function lstatIfPresent(path: string): Stats | null {
    try {
        return lstatSync(path);
    } catch (error) {
        if (isMissingPathError(error)) return null;
        throw error;
    }
}

/* */
export function captureDatabaseFamilyIdentities(dbPath: string): DatabaseFileIdentity[] {
    const identities: DatabaseFileIdentity[] = [];
    for (const role of DATABASE_FAMILY_MOVE_ORDER) {
        const stats = lstatIfPresent(databaseFamilyFilePath(dbPath, role));
        if (stats === null) continue;
        if (!stats.isFile()) {
            throw new Error(
                `${databaseFamilyFilePath(dbPath, role)} is not a regular database-family file`,
            );
        }
        identities.push({ role, dev: stats.dev, ino: stats.ino, sizeBytes: stats.size });
    }
    return identities;
}

export interface DatabaseResetMarker {
    readonly protocol: typeof RESET_MARKER_PROTOCOL;
    /** `dbPath` is the absolute path of the main database file bound by the marker. */
    readonly dbPath: string;
    readonly createdAtMs: number;
    /** `databaseIncarnationId` identifies the abandoned family and is null without a readable direct-format marker. */
    readonly databaseIncarnationId: string | null;
    /** `quarantineDirPath` is the same-directory destination for every move. */
    readonly quarantineDirPath: string;
    /** `fileIdentities` records every family file that existed at marker publication. */
    readonly fileIdentities: readonly DatabaseFileIdentity[];
    /* */
    readonly markerDigest: string;
}

/* */
export function canonicalResetMarkerLines(
    marker: Omit<DatabaseResetMarker, "markerDigest">,
): string[] {
    return [
        RESET_MARKER_PROTOCOL,
        `db_path=${marker.dbPath}`,
        `created_at_ms=${marker.createdAtMs}`,
        `database_incarnation_id=${marker.databaseIncarnationId ?? "none"}`,
        `quarantine_dir=${marker.quarantineDirPath}`,
        ...marker.fileIdentities.map(
            (file) =>
                `file role=${file.role} dev=${file.dev} ino=${file.ino} size_bytes=${file.sizeBytes}`,
        ),
    ];
}

export function computeResetMarkerDigest(
    marker: Omit<DatabaseResetMarker, "markerDigest">,
): string {
    return createHash("sha256")
        .update(canonicalResetMarkerLines(marker).join("\n"), "utf8")
        .digest("hex");
}

export function buildDatabaseResetMarker(input: {
    dbPath: string;
    createdAtMs: number;
    databaseIncarnationId: string | null;
    quarantineDirPath: string;
    fileIdentities: readonly DatabaseFileIdentity[];
}): DatabaseResetMarker {
    if (
        input.databaseIncarnationId !== null &&
        !isValidDatabaseIncarnationId(input.databaseIncarnationId)
    ) {
        throw new Error(`invalid database incarnation ID: ${input.databaseIncarnationId}`);
    }
    if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) {
        throw new Error(`invalid reset marker creation time: ${input.createdAtMs}`);
    }
    const pathProblem = validateResetMarkerPaths(input.dbPath, input.quarantineDirPath);
    if (pathProblem !== null) throw new Error(pathProblem);
    const identityProblem = validateResetMarkerIdentities(input.fileIdentities);
    if (identityProblem !== null) throw new Error(identityProblem);
    const withoutDigest = { protocol: RESET_MARKER_PROTOCOL, ...input } as const;
    return { ...withoutDigest, markerDigest: computeResetMarkerDigest(withoutDigest) };
}

/**
 */
export interface ResetMarkerPublicationFs {
    readonly openSync: (path: string, flags: string, mode: number) => number;
    readonly writeSync: (fd: number, buffer: Buffer, offset: number, length: number) => number;
    readonly fsyncSync: (fd: number) => void;
    readonly closeSync: (fd: number) => void;
    readonly chmodSync: (path: string, mode: number) => void;
    readonly unlinkSync: (path: string) => void;
}

const defaultResetMarkerPublicationFs: ResetMarkerPublicationFs = {
    openSync,
    writeSync,
    fsyncSync,
    closeSync,
    chmodSync,
    unlinkSync,
};

/**
 * `writeSync` may return a short write; resume from the reported count until the complete marker is written.
 * A zero-byte `writeSync` result fails publication to prevent an infinite retry loop.
 */
function writeAllResetMarkerBytes(fs: ResetMarkerPublicationFs, fd: number, bytes: Buffer): void {
    let written = 0;
    while (written < bytes.length) {
        const count = fs.writeSync(fd, bytes, written, bytes.length - written);
        if (!Number.isInteger(count) || count <= 0) {
            throw new Error(
                `reset marker write made no progress after ${written} of ${bytes.length} bytes`,
            );
        }
        written += count;
    }
}

/** The cleanup function returns null when no marker file remains; otherwise it returns the cleanup error. */
function discardPartialResetMarker(
    fs: ResetMarkerPublicationFs,
    fd: number,
    path: string,
): string | null {
    try {
        fs.closeSync(fd);
    } catch {
        // `closeSync` must not be retried because the descriptor number may already be recycled.
        // The caller needs the cleanup error, not a retry error from a recycled descriptor.
        // File removal determines whether cleanup succeeded.
        // stays openable.
    }
    try {
        fs.unlinkSync(path);
        return null;
    } catch (error) {
        if (isMissingPathError(error)) return null;
        return error instanceof Error ? error.message : String(error);
    }
}

/**
 * Publication succeeds only after the complete marker is written and fsynced.
 *
 * `wx` succeeds only when this call creates the marker.
 * `wx` must not overwrite an existing marker.
 * The failure path can unlink only an unpublished marker created by this call.
 * A failed open does not alter an existing marker.
 *
 * Marker presence blocks database initialization.
 * Recovery treats malformed markers as blocking, not resumable.
 * A failed write removes the unpublished marker when cleanup succeeds.
 * Successful fsync is the crash boundary after which recovery can trust marker presence.
 * A close failure after fsync leaves a valid, resumable pending marker.
 */
export function writeDatabaseResetMarker(
    marker: DatabaseResetMarker,
    fs: ResetMarkerPublicationFs = defaultResetMarkerPublicationFs,
): void {
    const path = databaseResetMarkerPath(marker.dbPath);
    const fd = fs.openSync(path, "wx", 0o600);
    try {
        writeAllResetMarkerBytes(fs, fd, Buffer.from(`${JSON.stringify(marker)}\n`, "utf8"));
        fs.fsyncSync(fd);
        fs.chmodSync(path, 0o600);
    } catch (error) {
        const cleanupProblem = discardPartialResetMarker(fs, fd, path);
        if (cleanupProblem === null) throw error;
        // A cleanup failure leaves the unpublished marker in place.
        // The partial marker blocks reopening until removed.
        throw new Error(
            `${error instanceof Error ? error.message : String(error)} (the partial reset marker ${path} could not be removed: ${cleanupProblem}; remove it manually before reopening the database)`,
            { cause: error },
        );
    }
    fs.closeSync(fd);
}

export type DatabaseResetMarkerRead =
    | { status: "absent" }
    | { status: "malformed"; reason: string }
    | { status: "present"; marker: DatabaseResetMarker };

const FAMILY_ROLE_SET = new Set<string>(DATABASE_FAMILY_MOVE_ORDER);
const SHA256_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function validateResetMarkerPaths(dbPath: string, quarantineDirPath: string): string | null {
    if (!isAbsolute(dbPath) || resolve(dbPath) !== dbPath) {
        return "reset marker db path must be an absolute normalized path";
    }
    if (!isAbsolute(quarantineDirPath) || resolve(quarantineDirPath) !== quarantineDirPath) {
        return "reset marker quarantine path must be an absolute normalized path";
    }
    if (dirname(quarantineDirPath) !== dirname(dbPath)) {
        return "reset marker quarantine path is not beside the database";
    }
    if (
        !basename(quarantineDirPath).startsWith(
            `${basename(dbPath)}${DATABASE_QUARANTINE_DIR_INFIX}`,
        )
    ) {
        return "reset marker quarantine path does not use the reserved database prefix";
    }
    return null;
}

function validateResetMarkerIdentities(
    fileIdentities: readonly DatabaseFileIdentity[],
): string | null {
    let lastOrder = -1;
    const seen = new Set<DatabaseFamilyFileRole>();
    for (const file of fileIdentities) {
        if (!FAMILY_ROLE_SET.has(file.role)) return "reset marker file identity role is invalid";
        if (seen.has(file.role)) return `reset marker repeats the ${file.role} file identity`;
        seen.add(file.role);
        const order = DATABASE_FAMILY_MOVE_ORDER.indexOf(file.role);
        if (order <= lastOrder) return "reset marker file identities are not in move order";
        lastOrder = order;
        if (
            !Number.isSafeInteger(file.dev) ||
            file.dev < 0 ||
            !Number.isSafeInteger(file.ino) ||
            file.ino < 0 ||
            !Number.isSafeInteger(file.sizeBytes) ||
            file.sizeBytes < 0
        ) {
            return "reset marker file identity entry is invalid";
        }
    }
    return null;
}

/** The reader recomputes the marker digest instead of trusting the stored digest. */
export function readDatabaseResetMarker(dbPath: string): DatabaseResetMarkerRead {
    const path = databaseResetMarkerPath(dbPath);
    if (!existsSync(path)) return { status: "absent" };
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        return {
            status: "malformed",
            reason: `reset marker is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    if (typeof parsed !== "object" || parsed === null) {
        return { status: "malformed", reason: "reset marker is not a JSON object" };
    }
    const raw = parsed as Record<string, unknown>;
    if (raw.protocol !== RESET_MARKER_PROTOCOL) {
        return { status: "malformed", reason: `unknown reset marker protocol: ${raw.protocol}` };
    }
    if (typeof raw.dbPath !== "string" || raw.dbPath !== dbPath) {
        return { status: "malformed", reason: "reset marker db path does not match its filename" };
    }
    if (!Number.isSafeInteger(raw.createdAtMs) || (raw.createdAtMs as number) < 0) {
        return { status: "malformed", reason: "reset marker creation time is invalid" };
    }
    if (
        raw.databaseIncarnationId !== null &&
        (typeof raw.databaseIncarnationId !== "string" ||
            !isValidDatabaseIncarnationId(raw.databaseIncarnationId))
    ) {
        return { status: "malformed", reason: "reset marker database incarnation ID is invalid" };
    }
    if (typeof raw.quarantineDirPath !== "string") {
        return { status: "malformed", reason: "reset marker quarantine path is invalid" };
    }
    const pathProblem = validateResetMarkerPaths(raw.dbPath, raw.quarantineDirPath);
    if (pathProblem !== null) return { status: "malformed", reason: pathProblem };
    if (!Array.isArray(raw.fileIdentities)) {
        return { status: "malformed", reason: "reset marker file identities are invalid" };
    }
    const fileIdentities: DatabaseFileIdentity[] = [];
    for (const entry of raw.fileIdentities as unknown[]) {
        const file = entry as Record<string, unknown>;
        if (typeof file !== "object" || file === null || typeof file.role !== "string") {
            return { status: "malformed", reason: "reset marker file identity entry is invalid" };
        }
        fileIdentities.push({
            role: file.role as DatabaseFamilyFileRole,
            dev: file.dev as number,
            ino: file.ino as number,
            sizeBytes: file.sizeBytes as number,
        });
    }
    const identityProblem = validateResetMarkerIdentities(fileIdentities);
    if (identityProblem !== null) return { status: "malformed", reason: identityProblem };
    const withoutDigest = {
        protocol: RESET_MARKER_PROTOCOL,
        dbPath: raw.dbPath,
        createdAtMs: raw.createdAtMs as number,
        databaseIncarnationId: raw.databaseIncarnationId as string | null,
        quarantineDirPath: raw.quarantineDirPath,
        fileIdentities,
    } as const;
    if (
        typeof raw.markerDigest !== "string" ||
        !SHA256_DIGEST_PATTERN.test(raw.markerDigest) ||
        computeResetMarkerDigest(withoutDigest) !== raw.markerDigest
    ) {
        return { status: "malformed", reason: "reset marker digest mismatch" };
    }
    return {
        status: "present",
        marker: { ...withoutDigest, markerDigest: raw.markerDigest as string },
    };
}

export type ResetFamilyFileStatus = "at-source" | "moved" | "mismatch" | "missing";

export interface ResetFamilyFileCheck {
    readonly role: DatabaseFamilyFileRole;
    readonly status: ResetFamilyFileStatus;
}

export interface ResetMarkerFamilyVerification {
    readonly files: readonly ResetFamilyFileCheck[];
    /** A family file absent from the marker indicates that the family changed. */
    readonly unexpectedFamilyFiles: readonly string[];
    /** The function returns true when any recorded file is already in quarantine. */
    readonly anyMoved: boolean;
    /** The function returns false when I/O prevents a complete source/destination identity check. */
    readonly inspectionComplete: boolean;
    /** An empty `problems` array permits quarantine to proceed or resume. */
    readonly problems: readonly string[];
}

/**
 * An atomic rename leaves each recorded file either at its source path or in quarantine.
 * Each recorded file must match its recorded identity at either its source path or quarantine path.
 * new inode.
 *
 * Size is not compared for any role at either location.
 * A holder can change file sizes after identities are recorded and before exclusivity is verified.
 * A holder can grow or truncate a main file, WAL, shared-memory index, or rollback journal without changing `dev` or `ino`.
 * A WAL checkpoint can truncate the WAL to zero without changing `dev` or `ino`.
 * A moved file retains size changes made before the move, so the destination is no safer than the source.
 * Size equality can cause spurious refusals that abandon a live family.
 * Closing the inode-reuse gap requires content identity, which `DatabaseResetMarker` does not record.
 */
export function verifyResetMarkerFamily(
    marker: DatabaseResetMarker,
): ResetMarkerFamilyVerification {
    const files: ResetFamilyFileCheck[] = [];
    const unexpectedFamilyFiles: string[] = [];
    const problems: string[] = [];
    let inspectionComplete = true;
    for (const role of DATABASE_FAMILY_MOVE_ORDER) {
        const sourcePath = databaseFamilyFilePath(marker.dbPath, role);
        const destinationPath = join(marker.quarantineDirPath, basename(sourcePath));
        const recorded = marker.fileIdentities.find((file) => file.role === role);
        let source: Stats | null;
        let destination: Stats | null;
        try {
            source = lstatIfPresent(sourcePath);
            destination = lstatIfPresent(destinationPath);
        } catch (error) {
            inspectionComplete = false;
            problems.push(
                `could not inspect the ${role} file identity: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
        }
        if (!recorded) {
            for (const path of [
                source === null ? null : sourcePath,
                destination === null ? null : destinationPath,
            ]) {
                if (path === null) continue;
                unexpectedFamilyFiles.push(path);
                problems.push(
                    `an unrecorded ${role} file appeared at ${path} after the reset marker was published`,
                );
            }
            continue;
        }
        if (source !== null && destination !== null) {
            files.push({ role, status: "mismatch" });
            problems.push(`the recorded ${role} file exists at both source and quarantine paths`);
            continue;
        }
        const found = source ?? destination;
        if (found === null) {
            files.push({ role, status: "missing" });
            problems.push(
                `the recorded ${role} file disappeared from ${sourcePath} without reaching quarantine`,
            );
            continue;
        }
        if (!found.isFile() || found.dev !== recorded.dev || found.ino !== recorded.ino) {
            files.push({ role, status: "mismatch" });
            const foundPath = source === null ? destinationPath : sourcePath;
            problems.push(
                `the ${role} file at ${foundPath} changed identity since the reset marker was published (recorded dev=${recorded.dev} ino=${recorded.ino}, found dev=${found.dev} ino=${found.ino})`,
            );
            continue;
        }
        files.push({ role, status: source === null ? "moved" : "at-source" });
    }
    return {
        files,
        unexpectedFamilyFiles,
        anyMoved: files.some((file) => file.status === "moved"),
        inspectionComplete,
        problems,
    };
}

/**
 */
export function inspectDatabaseForClassification(
    db: Database,
    dbPath?: string,
): FormatFamilyInspection {
    const applicationId = Number(
        (db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id,
    );
    const userVersion = Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
    const schemaObjectNames = (
        db
            .prepare(
                "SELECT name FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all() as Array<{ name: string }>
    ).map((row) => row.name);
    return {
        mainFileExists: dbPath === undefined ? true : existsSync(dbPath),
        applicationId,
        userVersion,
        schemaObjectNames,
        marker: readDirectFormatMarker(db),
        artifacts: dbPath === undefined ? [] : listDatabaseFamilyArtifacts(dbPath),
    };
}
