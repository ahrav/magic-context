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
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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

/** Identities of every family file that currently exists on disk, in move order. */
export function captureDatabaseFamilyIdentities(dbPath: string): DatabaseFileIdentity[] {
    const identities: DatabaseFileIdentity[] = [];
    for (const role of DATABASE_FAMILY_MOVE_ORDER) {
        let stats: ReturnType<typeof statSync>;
        try {
            stats = statSync(databaseFamilyFilePath(dbPath, role));
        } catch {
            continue;
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
    const withoutDigest = { protocol: RESET_MARKER_PROTOCOL, ...input } as const;
    return { ...withoutDigest, markerDigest: computeResetMarkerDigest(withoutDigest) };
}

/**
 * Publish the reset marker as a private file beside the database. `wx` makes
 * publication race-safe (a concurrent reset fails instead of overwriting),
 * and a torn write fails the digest check on read, so recovery refuses it.
 */
export function writeDatabaseResetMarker(marker: DatabaseResetMarker): void {
    writeFileSync(databaseResetMarkerPath(marker.dbPath), `${JSON.stringify(marker)}\n`, {
        mode: 0o600,
        flag: "wx",
    });
}

export type DatabaseResetMarkerRead =
    | { status: "absent" }
    | { status: "malformed"; reason: string }
    | { status: "present"; marker: DatabaseResetMarker };

const FAMILY_ROLE_SET = new Set<string>(DATABASE_FAMILY_MOVE_ORDER);

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
    if (typeof raw.dbPath !== "string" || raw.dbPath.length === 0) {
        return { status: "malformed", reason: "reset marker db path is invalid" };
    }
    if (!Number.isSafeInteger(raw.createdAtMs)) {
        return { status: "malformed", reason: "reset marker creation time is invalid" };
    }
    if (
        raw.databaseIncarnationId !== null &&
        (typeof raw.databaseIncarnationId !== "string" ||
            !isValidDatabaseIncarnationId(raw.databaseIncarnationId))
    ) {
        return { status: "malformed", reason: "reset marker database incarnation ID is invalid" };
    }
    if (typeof raw.quarantineDirPath !== "string" || raw.quarantineDirPath.length === 0) {
        return { status: "malformed", reason: "reset marker quarantine path is invalid" };
    }
    if (!Array.isArray(raw.fileIdentities)) {
        return { status: "malformed", reason: "reset marker file identities are invalid" };
    }
    const fileIdentities: DatabaseFileIdentity[] = [];
    for (const entry of raw.fileIdentities as unknown[]) {
        const file = entry as Record<string, unknown>;
        if (
            typeof file !== "object" ||
            file === null ||
            typeof file.role !== "string" ||
            !FAMILY_ROLE_SET.has(file.role) ||
            !Number.isSafeInteger(file.dev) ||
            !Number.isSafeInteger(file.ino) ||
            !Number.isSafeInteger(file.sizeBytes)
        ) {
            return { status: "malformed", reason: "reset marker file identity entry is invalid" };
        }
        fileIdentities.push({
            role: file.role as DatabaseFamilyFileRole,
            dev: file.dev as number,
            ino: file.ino as number,
            sizeBytes: file.sizeBytes as number,
        });
    }
    const withoutDigest = {
        protocol: RESET_MARKER_PROTOCOL,
        dbPath: raw.dbPath,
        createdAtMs: raw.createdAtMs as number,
        databaseIncarnationId: raw.databaseIncarnationId as string | null,
        quarantineDirPath: raw.quarantineDirPath,
        fileIdentities,
    } as const;
    if (computeResetMarkerDigest(withoutDigest) !== raw.markerDigest) {
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
    /** Empty means the quarantine may proceed or resume. */
    readonly problems: readonly string[];
}

/**
 * Compare the on-disk family against the published marker. Identity is
 * dev/inode only: a rename is atomic, so every recorded file is either still
 * at its source (identity must match) or already inside quarantine. Size is
 * deliberately not compared — a live writer is the holder inspection's job.
 * "Became current" is covered by the same check: only a pristine family can
 * bootstrap to current, so a current database at this path necessarily has a
 * new inode.
 */
export function verifyResetMarkerFamily(marker: DatabaseResetMarker): ResetMarkerFamilyVerification {
    const files: ResetFamilyFileCheck[] = [];
    const unexpectedFamilyFiles: string[] = [];
    const problems: string[] = [];
    for (const role of DATABASE_FAMILY_MOVE_ORDER) {
        const sourcePath = databaseFamilyFilePath(marker.dbPath, role);
        const recorded = marker.fileIdentities.find((file) => file.role === role);
        if (!recorded) {
            if (existsSync(sourcePath)) {
                unexpectedFamilyFiles.push(sourcePath);
                problems.push(
                    `an unrecorded ${role} file appeared at ${sourcePath} after the reset marker was published`,
                );
            }
            continue;
        }
        let stats: ReturnType<typeof statSync> | null = null;
        try {
            stats = statSync(sourcePath);
        } catch {
            stats = null;
        }
        if (stats !== null) {
            if (stats.dev === recorded.dev && stats.ino === recorded.ino) {
                files.push({ role, status: "at-source" });
            } else {
                files.push({ role, status: "mismatch" });
                problems.push(
                    `the ${role} file at ${sourcePath} changed identity since the reset marker was published (recorded dev=${recorded.dev} ino=${recorded.ino}, found dev=${stats.dev} ino=${stats.ino})`,
                );
            }
            continue;
        }
        if (existsSync(join(marker.quarantineDirPath, basename(sourcePath)))) {
            files.push({ role, status: "moved" });
        } else {
            files.push({ role, status: "missing" });
            problems.push(
                `the recorded ${role} file disappeared from ${sourcePath} without reaching quarantine`,
            );
        }
    }
    return {
        files,
        unexpectedFamilyFiles,
        anyMoved: files.some((file) => file.status === "moved"),
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
