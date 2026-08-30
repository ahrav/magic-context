/**
 * Descriptor-anchored connection-file snapshot.
 *
 * Normative authority: `docs/mc-host-wire-protocol.md` Section 4. Two
 * explicit validation paths exist:
 *
 * - Direct regular file: pre-open `lstat`, `O_RDONLY | O_NOFOLLOW |
 *   O_NONBLOCK` open, `fstat` identity/ownership/mode checks, bounded read
 *   through the descriptor, and a post-read `lstat` that must still identify
 *   the same file. One whole-snapshot restart is permitted after an atomic
 *   replacement; a second identity mismatch fails closed.
 * - Trusted symlink (explicit opt-in): capture link identity and text, open
 *   the resolved regular target with no-follow, validate the target, then
 *   prove both link and target unchanged. Any replacement fails closed.
 *
 * Failures are typed and redacted: no key or daemon-ID byte ever appears in
 * an error message. Directory components of both paths are trusted:
 * `O_NOFOLLOW` guards only the final component, and Node exposes no
 * `openat2`/`RESOLVE_BENEATH` to constrain the prefix, so the runtime
 * directory must not be writable by other users. Leaf-adjacent module:
 * imports only leaf modules and the Node standard library.
 */

import { constants as fsConstants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Deadline } from "./deadline";

/** Snapshot cap from wire doc Section 4.1: 65,536 bytes. */
export const MAX_CONNECTION_FILE_LEN = 65_536;
export const CONNECTION_FILE_SCHEMA = 2;
export const KEY_LEN = 32;
export const DAEMON_ID_LEN = 16;
/** Required in every connection file; any value other than 2 fails closed. */
export const WIRE_VERSION = 2;

export type ConnectionFileErrorCode =
    | "unsupported_platform"
    | "deadline_expired"
    | "not_found"
    | "open_failed"
    | "stat_failed"
    | "not_regular_file"
    | "foreign_owner"
    | "insecure_permissions"
    | "oversize"
    | "replaced_during_read"
    | "invalid_utf8"
    | "invalid_json"
    | "invalid_schema"
    | "invalid_wire_version"
    | "invalid_setup_socket"
    | "invalid_key"
    | "invalid_daemon_id"
    | "invalid_pid"
    | "invalid_daemon_ver";

/** Typed, redacted connection-file failure. Never carries credential bytes. */
export class ConnectionFileError extends Error {
    constructor(
        message: string,
        readonly code: ConnectionFileErrorCode,
        readonly cause?: unknown,
    ) {
        super(message);
        this.name = "ConnectionFileError";
    }
}

/** Immutable validated credential snapshot. */
export interface ConnectionSnapshot {
    readonly setupSocket: string;
    /** Exactly 32 key bytes. Bearer capability; must never be logged. */
    readonly key: Uint8Array;
    /** Exactly 16 daemon-identity bytes. */
    readonly daemonId: Uint8Array;
    readonly pid: number;
    readonly daemonVer: string;
}

export interface ReadConnectionFileOptions {
    /** Bounds the whole snapshot; checked between every filesystem step. */
    deadline: Deadline;
    /** Test seam for the unsupported-platform check. Defaults to the real one. */
    platform?: NodeJS.Platform;
    /** Test seam for the owning UID. Defaults to `process.getuid()`. */
    uid?: number;
    /**
     * Test seam invoked once per attempt after the target descriptor is
     * open, before any read. Lets tests race replacements deterministically.
     */
    afterOpen?: () => void | Promise<void>;
}

/**
 * Exact-length JSON byte-array validation lives in the shared `bytes` leaf;
 * re-exported here for the connection-file test suite.
 */
import { toExactByteArray } from "./bytes";

export { toExactByteArray };

function checkDeadline(deadline: Deadline): void {
    if (deadline.isExpired()) {
        throw new ConnectionFileError(
            "connection file snapshot deadline expired",
            "deadline_expired",
        );
    }
}

interface FileIdentity {
    dev: number | bigint;
    ino: number | bigint;
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
    return a.dev === b.dev && a.ino === b.ino;
}

function statErrno(error: unknown): string | undefined {
    if (error && typeof error === "object" && "code" in error) {
        const code = (error as { code?: unknown }).code;
        return typeof code === "string" ? code : undefined;
    }
    return undefined;
}

function currentUid(): number {
    if (typeof process.getuid !== "function") {
        throw new ConnectionFileError(
            "cannot determine process uid on this platform",
            "unsupported_platform",
        );
    }
    return process.getuid();
}

async function openNoFollow(filePath: string): Promise<FileHandle> {
    try {
        return await open(
            filePath,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
        );
    } catch (error) {
        // Only absence (ENOENT) is retryable republication churn; EACCES,
        // ELOOP, descriptor exhaustion, and every other open fault is
        // permanent evidence that must stop a recovery episode.
        if (statErrno(error) === "ENOENT") {
            throw new ConnectionFileError(
                `connection file ${filePath} does not exist`,
                "not_found",
                error,
            );
        }
        throw new ConnectionFileError(
            `failed to open connection file ${filePath}`,
            "open_failed",
            error,
        );
    }
}

/**
 * Read up to cap + 1 bytes through the descriptor so an oversize file is
 * detected from the bytes actually read, not from possibly-stale metadata.
 * The deadline is re-checked between reads; one in-flight `read()` cannot
 * be cancelled, so a stalled filesystem can still exceed the budget by at
 * most one syscall.
 */
async function readBounded(handle: FileHandle, deadline: Deadline): Promise<Uint8Array> {
    const buffer = Buffer.alloc(MAX_CONNECTION_FILE_LEN + 1);
    let total = 0;
    while (total < buffer.length) {
        checkDeadline(deadline);
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
    }
    if (total > MAX_CONNECTION_FILE_LEN) {
        throw new ConnectionFileError(
            `connection file exceeds the ${MAX_CONNECTION_FILE_LEN}-byte snapshot cap`,
            "oversize",
        );
    }
    return buffer.subarray(0, total);
}

/**
 * Validate the descriptor after open: regular file, owned by this process,
 * no group/other permission bits. Ordered so a FIFO or directory descriptor
 * is rejected before any read could block or misbehave.
 */
function validateOpenStat(
    stat: { isFile(): boolean; uid: number; mode: number },
    uid: number,
    what: string,
): void {
    if (!stat.isFile()) {
        throw new ConnectionFileError(`${what} is not a regular file`, "not_regular_file");
    }
    if (stat.uid !== uid) {
        throw new ConnectionFileError(`${what} is not owned by the current user`, "foreign_owner");
    }
    if ((stat.mode & 0o077) !== 0) {
        throw new ConnectionFileError(
            `${what} has group or other permission bits; expected owner-only mode`,
            "insecure_permissions",
        );
    }
}

/** One direct-file snapshot attempt. Identity mismatch = `replaced_during_read`. */
async function snapshotDirect(
    filePath: string,
    deadline: Deadline,
    uid: number,
    afterOpen?: () => void | Promise<void>,
): Promise<Uint8Array> {
    checkDeadline(deadline);
    // Stat failures split by errno: an absent path (ENOENT) during daemon
    // republication is retryable `not_found` churn, while EACCES, ENOTDIR,
    // ELOOP, and every other stat fault is permanent configuration
    // evidence (`stat_failed`) that must stop a recovery episode instead
    // of retrying to its deadline.
    const before = await lstat(filePath).catch((error: unknown) => {
        if (statErrno(error) === "ENOENT") {
            throw new ConnectionFileError(
                `connection file ${filePath} does not exist`,
                "not_found",
                error,
            );
        }
        throw new ConnectionFileError(
            `failed to stat connection file ${filePath}`,
            "stat_failed",
            error,
        );
    });
    if (before.isSymbolicLink()) {
        throw new ConnectionFileError(
            `connection file ${filePath} is a symlink; client discovery must reject symbolic links`,
            "not_regular_file",
        );
    }
    if (!before.isFile()) {
        throw new ConnectionFileError(
            `connection file ${filePath} is not a regular file`,
            "not_regular_file",
        );
    }
    checkDeadline(deadline);
    const handle = await openNoFollow(filePath);
    try {
        await afterOpen?.();
        const during = await handle.stat();
        if (!sameIdentity(before, during)) {
            throw new ConnectionFileError(
                `connection file ${filePath} was replaced between lstat and open`,
                "replaced_during_read",
            );
        }
        validateOpenStat(during, uid, `connection file ${filePath}`);
        checkDeadline(deadline);
        const bytes = await readBounded(handle, deadline);
        checkDeadline(deadline);
        // An unlink after the read (ENOENT) is a replacement event: the
        // one-restart rule (KTD3) and churn retry classification apply.
        // Any other stat fault is permanent evidence, as above.
        const after = await lstat(filePath).catch((error: unknown) => {
            if (statErrno(error) === "ENOENT") {
                throw new ConnectionFileError(
                    `connection file ${filePath} was removed during the snapshot`,
                    "replaced_during_read",
                    error,
                );
            }
            throw new ConnectionFileError(
                `failed to re-stat connection file ${filePath}`,
                "stat_failed",
                error,
            );
        });
        if (!after.isFile() || !sameIdentity(during, after)) {
            throw new ConnectionFileError(
                `connection file ${filePath} was replaced during the snapshot`,
                "replaced_during_read",
            );
        }
        return bytes;
    } finally {
        await handle.close().catch(() => {});
    }
}

function invalid(code: ConnectionFileErrorCode, message: string): ConnectionFileError {
    return new ConnectionFileError(message, code);
}

/**
 * Validate the decoded JSON against wire doc Section 4.1: schema 2,
 * a required wire version of exactly 2, an absolute setup-socket path,
 * exactly 32 key bytes, exactly 16 daemon-ID bytes, a safe
 * integer PID, and a nonempty daemon version. No coercion anywhere.
 */
function validateSnapshotJson(parsed: unknown): ConnectionSnapshot {
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw invalid("invalid_json", "connection file JSON must be an object");
    }
    const record = parsed as Record<string, unknown>;
    if (record.schema !== CONNECTION_FILE_SCHEMA) {
        throw invalid("invalid_schema", `connection file schema must be ${CONNECTION_FILE_SCHEMA}`);
    }
    if (record.wire_version !== WIRE_VERSION) {
        throw invalid(
            "invalid_wire_version",
            `connection file wire_version must be exactly ${WIRE_VERSION}`,
        );
    }
    const setupSocket = record.setup_socket;
    if (typeof setupSocket !== "string" || setupSocket.length === 0 || !isAbsolute(setupSocket)) {
        throw invalid(
            "invalid_setup_socket",
            "connection file setup_socket must be an absolute path",
        );
    }
    const key = toExactByteArray(record.key, KEY_LEN);
    if (key === null) {
        throw invalid(
            "invalid_key",
            `connection file key must be exactly ${KEY_LEN} integer bytes in 0..=255`,
        );
    }
    const daemonId = toExactByteArray(record.daemon_id, DAEMON_ID_LEN);
    if (daemonId === null) {
        throw invalid(
            "invalid_daemon_id",
            `connection file daemon_id must be exactly ${DAEMON_ID_LEN} integer bytes in 0..=255`,
        );
    }
    const pid = record.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
        throw invalid("invalid_pid", "connection file pid must be a positive integer");
    }
    const daemonVer = record.daemon_ver;
    if (typeof daemonVer !== "string" || daemonVer.length === 0) {
        throw invalid("invalid_daemon_ver", "connection file daemon_ver must be a nonempty string");
    }
    return Object.freeze({
        setupSocket,
        key,
        daemonId,
        pid,
        daemonVer,
    });
}

function decodeAndValidate(bytes: Uint8Array): ConnectionSnapshot {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
        throw new ConnectionFileError("connection file is not valid UTF-8", "invalid_utf8", error);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new ConnectionFileError("connection file is not valid JSON", "invalid_json", error);
    }
    return validateSnapshotJson(parsed);
}

/**
 * Take one bounded, descriptor-anchored snapshot of the connection file and
 * return the validated immutable credentials. JSON is parsed only after the
 * complete byte snapshot passed every identity check.
 */
export async function readConnectionFile(
    filePath: string,
    options: ReadConnectionFileOptions,
): Promise<ConnectionSnapshot> {
    const platform = options.platform ?? process.platform;
    if (platform === "win32") {
        throw new ConnectionFileError(
            "connection-file discovery is unsupported on win32; secure publication has no reviewed Windows contract",
            "unsupported_platform",
        );
    }
    const uid = options.uid ?? currentUid();
    let bytes: Uint8Array;
    try {
        bytes = await snapshotDirect(filePath, options.deadline, uid, options.afterOpen);
    } catch (error) {
        // KTD3: one whole-snapshot restart after an atomic replacement. A
        // second identity mismatch propagates and fails closed.
        if (!(error instanceof ConnectionFileError) || error.code !== "replaced_during_read") {
            throw error;
        }
        bytes = await snapshotDirect(filePath, options.deadline, uid, options.afterOpen);
    }
    return decodeAndValidate(bytes);
}
