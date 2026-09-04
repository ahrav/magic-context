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
import type { Deadline } from "./deadline";
/** Snapshot cap from wire doc Section 4.1: 65,536 bytes. */
export declare const MAX_CONNECTION_FILE_LEN = 65536;
export declare const CONNECTION_FILE_SCHEMA = 1;
export declare const KEY_LEN = 32;
export declare const DAEMON_ID_LEN = 16;
/** Required in every connection file; any value other than 2 fails closed. */
export declare const WIRE_VERSION = 2;
export type ConnectionFileErrorCode = "unsupported_platform" | "deadline_expired" | "not_found" | "open_failed" | "stat_failed" | "not_regular_file" | "foreign_owner" | "insecure_permissions" | "oversize" | "replaced_during_read" | "invalid_utf8" | "invalid_json" | "invalid_schema" | "invalid_wire_version" | "invalid_setup_socket" | "invalid_key" | "invalid_daemon_id" | "invalid_pid" | "invalid_daemon_ver";
/** Typed, redacted connection-file failure. Never carries credential bytes. */
export declare class ConnectionFileError extends Error {
    readonly code: ConnectionFileErrorCode;
    readonly cause?: unknown | undefined;
    constructor(message: string, code: ConnectionFileErrorCode, cause?: unknown | undefined);
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
/**
 * Take one bounded, descriptor-anchored snapshot of the connection file and
 * return the validated immutable credentials. JSON is parsed only after the
 * complete byte snapshot passed every identity check.
 */
export declare function readConnectionFile(filePath: string, options: ReadConnectionFileOptions): Promise<ConnectionSnapshot>;
//# sourceMappingURL=connection-file.d.ts.map