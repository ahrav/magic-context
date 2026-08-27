/**
 * U1 direct-cutover groundwork (KTD1, R15, R21): pure direct-format
 * classification, the database-incarnation identity, and the direct-format
 * marker vocabulary shared with the Rust runtimes (mc-store and the
 * dashboard). Nothing here is wired into the production open path yet — U8
 * activates the bootstrap; U11 owns reset.
 *
 * Cross-runtime vocabulary (asserted against
 * `fixtures/direct-format-vocabulary-v1.json` by every runtime's tests):
 *   - `PRAGMA application_id` = MC_APPLICATION_ID ("MCTX")
 *   - `PRAGMA user_version`   = DIRECT_FORMAT_EPOCH
 *   - one immutable `mc_format_marker` row binding format epoch, the random
 *     database-incarnation ID, the registered-component manifest digest, and
 *     a SHA-256 marker digest over all of them.
 *
 * Dependency-light on purpose: runtime imports use explicit `.ts` extensions
 * and `node:` builtins only, so the Node smoke scripts can load this module
 * under Node's type-stripping loader.
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

/** `PRAGMA application_id` value for the direct format: ASCII "MCTX". */
export const MC_APPLICATION_ID = 0x4d435458;

/**
 * `PRAGMA user_version` value for the direct format. The legacy migration
 * lane never wrote user_version (it stays 0 there), so any nonzero epoch is
 * unambiguously post-migration-era. Bump only on a breaking format change.
 */
export const DIRECT_FORMAT_EPOCH = 1;

export const DIRECT_FORMAT_MARKER_TABLE = "mc_format_marker";

/** Canonical protocol tag for the marker digest. */
export const FORMAT_MARKER_DIGEST_PROTOCOL = "mc-direct-format-marker-v1";

/**
 * Sidecar suffix reserved for U11's interruption-safe reset marker. U1 only
 * needs the vocabulary so classification can refuse a family with a pending
 * reset artifact.
 */
export const DATABASE_RESET_MARKER_SUFFIX = ".mc-reset";

export interface DirectFormatMarker {
    readonly formatEpoch: number;
    /** 128-bit random identity, 32 lowercase hex chars; immutable for the file's lifetime. */
    readonly databaseIncarnationId: string;
    /** SHA-256 hex digest of the registered-component manifest. */
    readonly componentManifestDigest: string;
    readonly createdAtMs: number;
    /** SHA-256 hex digest binding application ID, epoch, incarnation, manifest digest, and creation time. */
    readonly markerDigest: string;
}

const INCARNATION_ID_PATTERN = /^[0-9a-f]{32}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** Random, immutable database-incarnation identity (R16, KTD1). */
export function generateDatabaseIncarnationId(
    random: (byteCount: number) => Uint8Array = randomBytes,
): string {
    return Buffer.from(random(16)).toString("hex");
}

export function isValidDatabaseIncarnationId(candidate: string): boolean {
    return INCARNATION_ID_PATTERN.test(candidate);
}

/**
 * Canonical line encoding shared with Rust: protocol line then one
 * `key=value` line per bound field, joined with '\n' (no trailing newline).
 * The digest is SHA-256 hex over those bytes.
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
 * Marker DDL. The single row is immutable at the database boundary: UPDATE
 * and DELETE raise, and the `id = 1` check makes a second row impossible —
 * so the incarnation stamped at bootstrap survives for the file's lifetime.
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

/** Write the marker row and stamp the direct-format PRAGMA vocabulary. */
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

/** Read and integrity-check the marker row (digest recomputed, never trusted). */
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
// Pure format-family classification (KTD1 state machine inputs).
// ---------------------------------------------------------------------------

export type DatabaseFormatFamily =
    | "current"
    | "pristine"
    | "unsupported"
    | "malformed-marker"
    | "orphan-artifacts";

/** Everything classification looks at; gathered impurely, classified purely. */
export interface FormatFamilyInspection {
    readonly mainFileExists: boolean;
    readonly applicationId: number;
    readonly userVersion: number;
    /** Non-internal object names in `main.sqlite_schema`. */
    readonly schemaObjectNames: readonly string[];
    readonly marker: DirectFormatMarkerRead;
    /** Sidecar / journal / reset artifacts present on disk (e.g. "wal", "shm", "journal", "reset-marker"). */
    readonly artifacts: readonly string[];
}

/** The build's expectation of a current direct-format database. */
export interface ExpectedDirectFormat {
    readonly applicationId: number;
    readonly formatEpoch: number;
    readonly componentManifestDigest: string;
    /** Exact expected object inventory, including the marker objects. */
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
 * Pure classification (R15): a database is accepted only as the exact current
 * registered format or as a truly pristine family; every other shape is
 * refused with explicit reasons and no state change.
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

/** Disk artifacts belonging to the database family at `dbPath`. */
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

/** What the pre-open artifact gate decided; artifacts only, no SQLite open. */
export type PreOpenFamilyVerdict =
    | { readonly decision: "open" }
    | {
          readonly decision: "refuse";
          readonly family: "reset-pending" | "unsupported" | "orphan-artifacts";
          readonly reasons: readonly string[];
      };

/** Disk-only facts the pre-open gate classifies; gathered impurely. */
export interface PreOpenFamilyInput {
    readonly artifacts: readonly string[];
    readonly mainFileExists: boolean;
    readonly mainFileSize: number;
}

/**
 * Pure pre-open gate (R15, R17): decide from disk artifacts alone whether
 * SQLite may be opened at all, so open-time recovery can never consume an
 * orphan WAL or roll back a family this build has not classified.
 *
 * A rollback journal is only terminal beside a NONEMPTY main file. Beside a
 * missing or zero-length main file it is not foreign committed state: SQLite
 * writes a transaction's pages to the main file only at commit, so a pristine
 * bootstrap holding `BEGIN IMMEDIATE` leaves exactly `main:0 bytes` plus
 * `-journal` for the whole composition. Refusing that shape would reject a
 * concurrent bootstrapper's own in-flight journal (never reaching the
 * `busy_timeout` wait that serializes cold opens) and would permanently wedge
 * a bootstrap interrupted mid-transaction, even though rollback restores the
 * family to pristine. Such a family is handed to the write-lock-serialized
 * classification instead, which is what actually decides.
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
        // A WAL alongside an empty main file is an orphan, not a bootstrapper's
        // journal: DELETE-mode bootstrap never produces one. Fall through to the
        // orphan rules below rather than admitting an ambiguous family.
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
// U11 reset-marker and quarantine primitives (KTD11, R15-R16).
//
// An explicit reset publishes an interruption-safe private marker file
// (`${dbPath}.mc-reset`) BEFORE the final holder inspection, bound to the
// database incarnation and the dev/inode identities of every family file.
// Quarantine then moves the rollback journal and sidecars before the main
// file into a same-directory private directory, and finally moves the marker
// itself into that directory. A marker at the source path therefore always
// means "reset pending"; classification already refuses such a family (the
// `reset-marker` artifact), which is what keeps pristine bootstrap blocked
// until recovery resumes or rolls the quarantine back.
// ---------------------------------------------------------------------------

/** Canonical protocol tag for the reset-marker digest. */
export const RESET_MARKER_PROTOCOL = "mc-database-reset-marker-v1";

/** Same-directory quarantine directory: `${dbPath}${INFIX}${stamp}`. */
export const DATABASE_QUARANTINE_DIR_INFIX = ".mc-quarantine-";

export type DatabaseFamilyFileRole = "rollback-journal" | "wal" | "shm" | "main";

/** Quarantine move order (F7): rollback journal and sidecars before the main file. */
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

/** dev/inode identity of one family file, captured when the reset marker is published. */
export interface DatabaseFileIdentity {
    readonly role: DatabaseFamilyFileRole;
    readonly dev: number;
    readonly ino: number;
    /** Reported to the operator as logical-data-loss context; never used for identity checks. */
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

/** Identities of every family file that currently exists on disk, in move order. */
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
    /** Absolute path of the main database file the marker binds to. */
    readonly dbPath: string;
    readonly createdAtMs: number;
    /** Incarnation of the abandoned family; null when it has no readable direct-format marker. */
    readonly databaseIncarnationId: string | null;
    /** Same-directory quarantine destination every move targets. */
    readonly quarantineDirPath: string;
    /** Identities of every family file that existed when the marker was published. */
    readonly fileIdentities: readonly DatabaseFileIdentity[];
    /** SHA-256 hex digest binding every field above. */
    readonly markerDigest: string;
}

/** Canonical line encoding for the reset-marker digest (same style as the format marker). */
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
 * The filesystem calls marker publication makes, injectable so tests can drive
 * the partial-publication cleanup path (a short write, a failed fsync, a failed
 * chmod) that is otherwise unreachable from a healthy filesystem.
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
 * `writeSync` may report fewer bytes than requested, so one call is not a
 * write. Resume from the reported count until the whole marker has landed, and
 * fail closed if a call reports no progress rather than spinning.
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

/** Returns null once no marker file remains, else why cleanup could not finish. */
function discardPartialResetMarker(
    fs: ResetMarkerPublicationFs,
    fd: number,
    path: string,
): string | null {
    try {
        fs.closeSync(fd);
    } catch {
        // Retrying a failed close is unsafe — the descriptor number may already
        // be recycled — and its error is not the cause the caller needs. The
        // file removal below is the cleanup that decides whether the family
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
 * Publish the reset marker as an all-or-nothing artifact.
 *
 * `wx` is O_CREAT|O_EXCL, so a successful open proves THIS call created the
 * file: an existing marker belongs to a concurrent or prior reset and the open
 * fails without touching it. That is what makes the failure path safe to
 * unlink — it can only remove a file this call brought into existence and
 * never published. A failed open is left strictly alone.
 *
 * Publication is complete only once every byte is written and fsynced. Mere
 * presence of the path refuses database initialization, and a truncated marker
 * reads as malformed, which recovery treats as blocking rather than resumable,
 * so a half-written marker must leave no file at all. Successful fsync is the
 * crash boundary after which recovery may trust marker presence; a close
 * failure past that point leaves a valid, resumable pending marker.
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
        // Cleanup failed as well, so a partial marker really does remain and
        // only the operator can clear it. Surface that without losing the cause.
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

/** Read and integrity-check the reset marker file (digest recomputed, never trusted). */
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
    /** Family files on disk that the marker never recorded (the family changed). */
    readonly unexpectedFamilyFiles: readonly string[];
    /** True once any recorded file already reached quarantine. */
    readonly anyMoved: boolean;
    /** False when an I/O error prevented a complete source/destination identity check. */
    readonly inspectionComplete: boolean;
    /** Empty means the quarantine may proceed or resume. */
    readonly problems: readonly string[];
}

/**
 * Compare the on-disk family against the published marker. Identity is
 * dev/inode only: a rename is atomic, so every recorded file is either still
 * at its source (identity must match) or already inside quarantine.
 * "Became current" is covered by the same check: only a pristine family can
 * bootstrap to current, so a current database at this path necessarily has a
 * new inode.
 *
 * Size is deliberately not compared, for any role and at either location. The
 * marker records identities before the final holder inspection, so a recorded
 * size is a pre-exclusivity observation: a holder still writing in that window
 * grows or truncates the main file, WAL, shared-memory index, or rollback
 * journal in place while dev/inode stay fixed, and a WAL checkpoint truncates
 * to zero the same way. A file moved after the inspection carries whatever
 * size that window left it at, so the destination is no safer than the source.
 * Refusal is expensive — a pending marker blocks database initialization — so
 * size equality would trade a narrow inode-reuse gap for spurious refusals
 * that abandon a live family. Closing that gap needs content identity, which
 * this marker does not record.
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
 * Gather classification inputs from an open connection. Read-only: pragma
 * reads and schema reads only, so refusal paths never mutate the family.
 * `dbPath` is optional so in-memory databases classify with no artifacts.
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
