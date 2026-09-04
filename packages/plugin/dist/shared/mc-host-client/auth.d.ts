/**
 * Pure client authentication state machine (wire doc Section 5).
 *
 * Runs the exact three-message handshake — ClientHello, ServerProof,
 * ClientAuth — over injected bounded byte I/O. This module owns no socket
 * and never imports `node:net`; the connection engine adapts its socket
 * to {@link AuthByteIo}.
 *
 * Each message is a `u32` little-endian byte length followed by at most
 * 4,096 UTF-8 JSON bytes. Proofs are
 * `HMAC-SHA256(key, ASCII(domain) || client_nonce || server_nonce || daemon_id)`.
 * The client compares the server proof in constant time, then requires the
 * server's daemon ID to equal the connection-file daemon ID and its daemon
 * version to equal the connection-file `daemon_ver`, and emits no ClientAuth
 * until every check passes. Every failure is typed and redacted: no key,
 * nonce, or proof byte ever appears in an error message.
 */
import type { Deadline } from "./deadline";
export declare const NONCE_LEN = 32;
export declare const PROOF_LEN = 32;
export declare const AUTH_DAEMON_ID_LEN = 16;
/** Length 4,096 is valid; 4,097 is rejected before body allocation. */
export declare const MAX_AUTH_MESSAGE_LEN = 4096;
export declare const SERVER_PROOF_DOMAIN = "subc-server-v1";
export declare const CLIENT_AUTH_DOMAIN = "subc-client-v1";
export declare const CLIENT_ROLE = "client";
/**
 * Bounded byte I/O the handshake runs over. Implementations must resolve
 * `readExact` only with exactly `n` bytes and reject on EOF, error, or
 * deadline expiry; `write` must reject unless every byte was accepted for
 * transmission.
 */
export interface AuthByteIo {
    readExact(n: number, deadline: Deadline): Promise<Uint8Array>;
    write(bytes: Uint8Array, deadline: Deadline): Promise<void>;
}
export type AuthErrorCode = "deadline_expired" | "io_failure" | "message_too_large" | "malformed_message" | "proof_mismatch" | "daemon_id_mismatch" | "daemon_ver_mismatch" | "invalid_credentials";
/** Typed, redacted authentication failure. Never carries secret bytes. */
export declare class AuthError extends Error {
    readonly code: AuthErrorCode;
    readonly cause?: unknown | undefined;
    constructor(message: string, code: AuthErrorCode, cause?: unknown | undefined);
}
export interface AuthenticateOptions {
    /** Test seam for nonce generation. Defaults to `node:crypto` randomBytes. */
    generateNonce?: (length: number) => Uint8Array;
}
/**
 * One connection file's validated authentication material.
 *
 * `daemonVer` is the file's `daemon_ver`. It is the expected value the peer
 * must report, not a claim about the peer, and it is required: the version
 * cross-check runs on every handshake, so a caller with no expected version
 * has no authenticated connection to make.
 */
export interface AuthCredentials {
    key: Uint8Array;
    daemonId: Uint8Array;
    daemonVer: string;
}
/** Result of a successful handshake. */
export interface AuthResult {
    /**
     * The server-reported daemon version string, necessarily equal to
     * `credentials.daemonVer`: any other value fails the handshake.
     */
    daemonVer: string;
    daemonId: Uint8Array;
}
/**
 * `HMAC-SHA256(key, ASCII(domain) || client_nonce || server_nonce || daemon_id)`
 * per wire doc Section 5.2. Exported so tests can reproduce the committed
 * literal vectors independently of the transcript path.
 */
export declare function computeProof(key: Uint8Array, domain: string, clientNonce: Uint8Array, serverNonce: Uint8Array, daemonId: Uint8Array): Uint8Array;
/**
 * Run the client side of the three-message handshake over `io`, bounded by
 * `deadline`. Emits ClientAuth only after the server proof passed a
 * constant-time comparison AND the server's daemon ID equals
 * `credentials.daemonId` AND the server's daemon version equals
 * `credentials.daemonVer`. Any malformed field, proof mismatch, daemon-ID
 * mismatch, daemon-version mismatch, EOF, or deadline expiry rejects with a
 * typed {@link AuthError} and writes nothing further.
 */
export declare function authenticateClient(io: AuthByteIo, credentials: AuthCredentials, deadline: Deadline, options?: AuthenticateOptions): Promise<AuthResult>;
//# sourceMappingURL=auth.d.ts.map