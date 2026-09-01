/**
 * The reader anchors each snapshot to an open descriptor.
 *
 * Section 4 of `docs/mc-host-wire-protocol.md` defines the connection-file snapshot contract.
 *
 * For a direct regular file, the reader opens with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`.
 * The reader validates descriptor identity, ownership, and mode before a bounded descriptor read.
 * The reader requires post-read `lstat` identity to match the opened file.
 * The reader restarts the whole snapshot once after an atomic replacement.
 * A second identity mismatch fails closed.
 * For an explicitly trusted symlink, the reader captures the link identity and text before opening its resolved target with no-follow.
 * The reader validates the target and requires both link and target identities to remain unchanged.
 * Any symlink or resolved-target replacement fails closed.
 *
 * Errors expose typed, redacted failures and never include key or daemon-ID bytes.
 * The runtime trusts directory components of both paths.
 * `O_NOFOLLOW` guards only the final path component.
 * Node exposes no `openat2` or `RESOLVE_BENEATH` API to constrain path prefixes.
 * The runtime directory must not be writable by other users.
 */

import { constants as fsConstants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Deadline } from "./deadline";

/** The wire protocol caps snapshots at 65,536 bytes. */
export const MAX_CONNECTION_FILE_LEN = 65_536;
export const CONNECTION_FILE_SCHEMA = 2;
export const KEY_LEN = 32;
export const DAEMON_ID_LEN = 16;
/** The reader rejects every wire-version value other than 2. */
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

/** Callers must not pass credential bytes in `message` or `cause`. */
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

/* */
export interface ConnectionSnapshot {
    readonly setupSocket: string;
    /** Exactly 32 key bytes. Bearer capability; must never be logged. */
    readonly key: Uint8Array;
    /** The daemon ID contains exactly 16 bytes. */
    readonly daemonId: Uint8Array;
    readonly pid: number;
    readonly daemonVer: string;
}

export interface ReadConnectionFileOptions {
    /** The reader checks the deadline between filesystem steps and bounds the entire snapshot. */
    deadline: Deadline;
    /** When omitted, `platform` defaults to the real platform. */
    platform?: NodeJS.Platform;
    /** When omitted, `uid` defaults to `process.getuid()`. */
    uid?: number;
    /**
     * The reader invokes `afterOpen` once per attempt after opening the target descriptor and before reading.
     * `afterOpen` lets tests race replacements deterministically.
     */
    afterOpen?: () => void | Promise<void>;
}

/**
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
        // The reader retries only `ENOENT`.
        // The reader fails closed for `EACCES`, `ELOOP`, descriptor exhaustion, and every other open fault.
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
 * The reader reads `MAX_CONNECTION_FILE_LEN + 1` bytes to detect oversize content without relying on stale metadata.
 * The reader reads `MAX_CONNECTION_FILE_LEN + 1` bytes to detect oversize content without relying on stale metadata.
 * The loop rechecks `deadline` between reads; an in-flight `handle.read()` cannot be cancelled and can exceed the deadline by one syscall.
 * The loop rechecks `deadline` between reads; an in-flight `handle.read()` cannot be cancelled and can exceed the deadline by one syscall.
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
 * validateOpenStat rejects non-regular descriptors before reads because FIFO reads can block.
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

/* */
async function snapshotDirect(
    filePath: string,
    deadline: Deadline,
    uid: number,
    afterOpen?: () => void | Promise<void>,
): Promise<Uint8Array> {
    checkDeadline(deadline);
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
        if (!(error instanceof ConnectionFileError) || error.code !== "replaced_during_read") {
            throw error;
        }
        bytes = await snapshotDirect(filePath, options.deadline, uid, options.afterOpen);
    }
    return decodeAndValidate(bytes);
}
