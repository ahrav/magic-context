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
import type { Database } from "../../shared/sqlite";
/** `PRAGMA application_id` value for the direct format: ASCII "MCTX". */
export declare const MC_APPLICATION_ID = 1296258136;
/**
 * `PRAGMA user_version` value for the direct format. The legacy migration
 * lane never wrote user_version (it stays 0 there), so any nonzero epoch is
 * unambiguously post-migration-era. Bump only on a breaking format change.
 */
export declare const DIRECT_FORMAT_EPOCH = 1;
export declare const DIRECT_FORMAT_MARKER_TABLE = "mc_format_marker";
/** Canonical protocol tag for the marker digest. */
export declare const FORMAT_MARKER_DIGEST_PROTOCOL = "mc-direct-format-marker-v1";
/**
 * Sidecar suffix reserved for U11's interruption-safe reset marker. U1 only
 * needs the vocabulary so classification can refuse a family with a pending
 * reset artifact.
 */
export declare const DATABASE_RESET_MARKER_SUFFIX = ".mc-reset";
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
/** Random, immutable database-incarnation identity (R16, KTD1). */
export declare function generateDatabaseIncarnationId(random?: (byteCount: number) => Uint8Array): string;
export declare function isValidDatabaseIncarnationId(candidate: string): boolean;
/**
 * Canonical line encoding shared with Rust: protocol line then one
 * `key=value` line per bound field, joined with '\n' (no trailing newline).
 * The digest is SHA-256 hex over those bytes.
 */
export declare function canonicalMarkerDigestLines(marker: Omit<DirectFormatMarker, "markerDigest">, applicationId?: number): string[];
export declare function computeMarkerDigest(marker: Omit<DirectFormatMarker, "markerDigest">, applicationId?: number): string;
export declare function buildDirectFormatMarker(input: {
    componentManifestDigest: string;
    createdAtMs: number;
    databaseIncarnationId?: string;
    formatEpoch?: number;
}): DirectFormatMarker;
/**
 * Marker DDL. The single row is immutable at the database boundary: UPDATE
 * and DELETE raise, and the `id = 1` check makes a second row impossible —
 * so the incarnation stamped at bootstrap survives for the file's lifetime.
 */
export declare function createDirectFormatMarkerSchema(db: Database): void;
/** Write the marker row and stamp the direct-format PRAGMA vocabulary. */
export declare function stampDirectFormatMarker(db: Database, marker: DirectFormatMarker): void;
export type DirectFormatMarkerRead = {
    status: "absent";
} | {
    status: "malformed";
    reason: string;
} | {
    status: "present";
    marker: DirectFormatMarker;
};
/** Read and integrity-check the marker row (digest recomputed, never trusted). */
export declare function readDirectFormatMarker(db: Database): DirectFormatMarkerRead;
export type DatabaseFormatFamily = "current" | "pristine" | "unsupported" | "malformed-marker" | "orphan-artifacts";
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
/**
 * Pure classification (R15): a database is accepted only as the exact current
 * registered format or as a truly pristine family; every other shape is
 * refused with explicit reasons and no state change.
 */
export declare function classifyDatabaseFormatFamily(inspection: FormatFamilyInspection, expected: ExpectedDirectFormat): FormatFamilyClassification;
/** Disk artifacts belonging to the database family at `dbPath`. */
export declare function listDatabaseFamilyArtifacts(dbPath: string, exists?: (path: string) => boolean): string[];
/** What the pre-open artifact gate decided; artifacts only, no SQLite open. */
export type PreOpenFamilyVerdict = {
    readonly decision: "open";
} | {
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
export declare function classifyPreOpenFamily(dbPath: string, input: PreOpenFamilyInput): PreOpenFamilyVerdict;
/** Canonical protocol tag for the reset-marker digest. */
export declare const RESET_MARKER_PROTOCOL = "mc-database-reset-marker-v1";
/** Same-directory quarantine directory: `${dbPath}${INFIX}${stamp}`. */
export declare const DATABASE_QUARANTINE_DIR_INFIX = ".mc-quarantine-";
export type DatabaseFamilyFileRole = "rollback-journal" | "wal" | "shm" | "main";
/** Quarantine move order (F7): rollback journal and sidecars before the main file. */
export declare const DATABASE_FAMILY_MOVE_ORDER: readonly DatabaseFamilyFileRole[];
export declare function databaseFamilyFilePath(dbPath: string, role: DatabaseFamilyFileRole): string;
export declare function databaseResetMarkerPath(dbPath: string): string;
/** dev/inode identity of one family file, captured when the reset marker is published. */
export interface DatabaseFileIdentity {
    readonly role: DatabaseFamilyFileRole;
    readonly dev: number;
    readonly ino: number;
    /** Reported to the operator as logical-data-loss context; never used for identity checks. */
    readonly sizeBytes: number;
}
/** Identities of every family file that currently exists on disk, in move order. */
export declare function captureDatabaseFamilyIdentities(dbPath: string): DatabaseFileIdentity[];
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
export declare function canonicalResetMarkerLines(marker: Omit<DatabaseResetMarker, "markerDigest">): string[];
export declare function computeResetMarkerDigest(marker: Omit<DatabaseResetMarker, "markerDigest">): string;
export declare function buildDatabaseResetMarker(input: {
    dbPath: string;
    createdAtMs: number;
    databaseIncarnationId: string | null;
    quarantineDirPath: string;
    fileIdentities: readonly DatabaseFileIdentity[];
}): DatabaseResetMarker;
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
export declare function writeDatabaseResetMarker(marker: DatabaseResetMarker, fs?: ResetMarkerPublicationFs): void;
export type DatabaseResetMarkerRead = {
    status: "absent";
} | {
    status: "malformed";
    reason: string;
} | {
    status: "present";
    marker: DatabaseResetMarker;
};
/** Read and integrity-check the reset marker file (digest recomputed, never trusted). */
export declare function readDatabaseResetMarker(dbPath: string): DatabaseResetMarkerRead;
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
export declare function verifyResetMarkerFamily(marker: DatabaseResetMarker): ResetMarkerFamilyVerification;
/**
 * Gather classification inputs from an open connection. Read-only: pragma
 * reads and schema reads only, so refusal paths never mutate the family.
 * `dbPath` is optional so in-memory databases classify with no artifacts.
 */
export declare function inspectDatabaseForClassification(db: Database, dbPath?: string): FormatFamilyInspection;
//# sourceMappingURL=storage-format-epoch.d.ts.map