/**
 * Descriptor-anchored connection-file snapshot (plan KTD3, R5-R6).
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
 * an error message. Leaf-adjacent module: imports only U1 leaves and the
 * Node standard library.
 */

import { constants as fsConstants } from "node:fs";
import { type FileHandle, lstat, open, readlink } from "node:fs/promises";
import path from "node:path";
import type { Deadline } from "./deadline";

/** Snapshot cap from wire doc Section 4.1: 65,536 bytes. */
export const MAX_CONNECTION_FILE_LEN = 65_536;
export const CONNECTION_FILE_SCHEMA = 1;
export const KEY_LEN = 32;
export const DAEMON_ID_LEN = 16;
/** Absent means fixed v2; any present value other than 2 fails closed. */
export const WIRE_VERSION = 2;

export type ConnectionFileErrorCode =
    | "unsupported_platform"
    | "deadline_expired"
    | "open_failed"
    | "not_regular_file"
    | "not_symlink"
    | "foreign_owner"
    | "insecure_permissions"
    | "oversize"
    | "replaced_during_read"
    | "invalid_utf8"
    | "invalid_json"
    | "invalid_schema"
    | "invalid_wire_version"
    | "invalid_endpoint"
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
    readonly endpoint: { readonly host: string; readonly port: number };
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
    /**
     * Explicit opt-in for the trusted-symlink publication form (wire doc
     * Section 4.2). Never auto-detected; a symlink at the path without this
     * flag fails closed.
     */
    trustedSymlink?: boolean;
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
 * Exact-length JSON byte-array validation (plan KTD3): every element must be
 * an own integer in `[0, 255]`. Sparse holes, `null`, fractions, negatives,
 * and values above 255 are all rejected without coercion.
 */
export function toExactByteArray(value: unknown, length: number): Uint8Array | null {
    if (!Array.isArray(value) || value.length !== length) return null;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        if (!Object.hasOwn(value, i)) return null;
        const element: unknown = value[i];
        if (typeof element !== "number" || !Number.isInteger(element)) return null;
        if (element < 0 || element > 255) return null;
        bytes[i] = element;
    }
    return bytes;
}

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
 */
async function readBounded(handle: FileHandle): Promise<Uint8Array> {
    const buffer = Buffer.alloc(MAX_CONNECTION_FILE_LEN + 1);
    let total = 0;
    while (total < buffer.length) {
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
    const before = await lstat(filePath);
    if (before.isSymbolicLink()) {
        throw new ConnectionFileError(
            `connection file ${filePath} is a symlink; the trusted-symlink form requires explicit opt-in`,
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
        const bytes = await readBounded(handle);
        checkDeadline(deadline);
        const after = await lstat(filePath);
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

/** Trusted-symlink snapshot. Any link or target replacement fails closed. */
async function snapshotTrustedSymlink(
    linkPath: string,
    deadline: Deadline,
    uid: number,
    afterOpen?: () => void | Promise<void>,
): Promise<Uint8Array> {
    checkDeadline(deadline);
    const linkBefore = await lstat(linkPath);
    if (!linkBefore.isSymbolicLink()) {
        throw new ConnectionFileError(
            `trusted connection-file path ${linkPath} is not a symlink`,
            "not_symlink",
        );
    }
    if (linkBefore.uid !== uid) {
        throw new ConnectionFileError(
            `trusted connection-file link ${linkPath} is not owned by the current user`,
            "foreign_owner",
        );
    }
    const linkText = await readlink(linkPath);
    const targetPath = path.resolve(path.dirname(linkPath), linkText);
    checkDeadline(deadline);
    const handle = await openNoFollow(targetPath);
    try {
        await afterOpen?.();
        const target = await handle.stat();
        validateOpenStat(target, uid, `connection file target ${targetPath}`);
        checkDeadline(deadline);
        const bytes = await readBounded(handle);
        checkDeadline(deadline);
        const linkAfter = await lstat(linkPath);
        if (!linkAfter.isSymbolicLink() || !sameIdentity(linkBefore, linkAfter)) {
            throw new ConnectionFileError(
                `trusted connection-file link ${linkPath} changed during the snapshot`,
                "replaced_during_read",
            );
        }
        const linkTextAfter = await readlink(linkPath);
        if (linkTextAfter !== linkText) {
            throw new ConnectionFileError(
                `trusted connection-file link ${linkPath} was retargeted during the snapshot`,
                "replaced_during_read",
            );
        }
        const targetAfter = await lstat(targetPath);
        if (!targetAfter.isFile() || !sameIdentity(target, targetAfter)) {
            throw new ConnectionFileError(
                `trusted connection-file target ${targetPath} was replaced during the snapshot`,
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
 * Validate the decoded JSON against wire doc Section 4.1: schema 1,
 * absent-or-2 wire version, first endpoint exactly `127.0.0.1` with a port
 * in `1..=65535`, exactly 32 key bytes, exactly 16 daemon-ID bytes, a safe
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
    if ("wire_version" in record && record.wire_version !== WIRE_VERSION) {
        throw invalid(
            "invalid_wire_version",
            `connection file wire_version must be absent or exactly ${WIRE_VERSION}`,
        );
    }
    const endpoints = record.endpoints;
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
        throw invalid("invalid_endpoint", "connection file must include at least one endpoint");
    }
    const first: unknown = endpoints[0];
    if (typeof first !== "object" || first === null || Array.isArray(first)) {
        throw invalid("invalid_endpoint", "connection file endpoints[0] must be an object");
    }
    const { host, port } = first as Record<string, unknown>;
    if (host !== "127.0.0.1") {
        throw invalid(
            "invalid_endpoint",
            "connection file endpoint host must be exactly 127.0.0.1",
        );
    }
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
        throw invalid(
            "invalid_endpoint",
            "connection file endpoint port must be an integer in 1..=65535",
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
    if (typeof pid !== "number" || !Number.isSafeInteger(pid)) {
        throw invalid("invalid_pid", "connection file pid must be a safe integer");
    }
    const daemonVer = record.daemon_ver;
    if (typeof daemonVer !== "string" || daemonVer.length === 0) {
        throw invalid("invalid_daemon_ver", "connection file daemon_ver must be a nonempty string");
    }
    return Object.freeze({
        endpoint: Object.freeze({ host: "127.0.0.1", port }),
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
    if (options.trustedSymlink) {
        const bytes = await snapshotTrustedSymlink(
            filePath,
            options.deadline,
            uid,
            options.afterOpen,
        );
        return decodeAndValidate(bytes);
    }
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
