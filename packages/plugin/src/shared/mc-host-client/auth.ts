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
 * `HMAC-SHA256(key, ASCII(domain) || client_nonce || server_nonce ||
 * u32be(len(daemon_ver)) || UTF8(daemon_ver) || daemon_id)`.
 * The client compares the server proof in constant time, then requires the
 * server's daemon ID to equal the connection-file daemon ID, and emits no
 * ClientAuth until both checks pass. Every failure is typed and redacted:
 * no key, nonce, or proof byte ever appears in an error message.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { toExactByteArray } from "./bytes";
import type { Deadline } from "./deadline";

export const NONCE_LEN = 32;
export const PROOF_LEN = 32;
const KEY_BYTE_LEN = 32;
export const AUTH_DAEMON_ID_LEN = 16;
/** Length 4,096 is valid; 4,097 is rejected before body allocation. */
export const MAX_AUTH_MESSAGE_LEN = 4_096;
export const SERVER_PROOF_DOMAIN = "subc-server-v1";
export const CLIENT_AUTH_DOMAIN = "subc-client-v1";
export const CLIENT_ROLE = "client";

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

export type AuthErrorCode =
    | "deadline_expired"
    | "io_failure"
    | "message_too_large"
    | "malformed_message"
    | "proof_mismatch"
    | "daemon_id_mismatch"
    | "invalid_credentials";

/** Typed, redacted authentication failure. Never carries secret bytes. */
export class AuthError extends Error {
    constructor(
        message: string,
        readonly code: AuthErrorCode,
        readonly cause?: unknown,
    ) {
        super(message);
        this.name = "AuthError";
    }
}

export interface AuthenticateOptions {
    /** Test seam for nonce generation. Defaults to `node:crypto` randomBytes. */
    generateNonce?: (length: number) => Uint8Array;
}

/** Result of a successful handshake. */
export interface AuthResult {
    /** The server-reported daemon version string (diagnostic metadata). */
    daemonVer: string;
    daemonId: Uint8Array;
}

/**
 * `HMAC-SHA256(key, ASCII(domain) || client_nonce || server_nonce ||
 * u32be(len(daemon_ver)) || UTF8(daemon_ver) || daemon_id)`
 * per wire doc Section 5.2. Exported so tests can reproduce the committed
 * literal vectors independently of the transcript path.
 */
export function computeProof(
    key: Uint8Array,
    domain: string,
    clientNonce: Uint8Array,
    serverNonce: Uint8Array,
    daemonVer: string,
    daemonId: Uint8Array,
): Uint8Array {
    const daemonVerBytes = Buffer.from(daemonVer, "utf8");
    const daemonVerLen = Buffer.allocUnsafe(4);
    daemonVerLen.writeUInt32BE(daemonVerBytes.length);
    const mac = createHmac("sha256", key);
    mac.update(Buffer.from(domain, "ascii"));
    mac.update(clientNonce);
    mac.update(serverNonce);
    mac.update(daemonVerLen);
    mac.update(daemonVerBytes);
    mac.update(daemonId);
    return new Uint8Array(mac.digest());
}

/**
 * Length-guarded constant-time equality. A length mismatch is an ordinary
 * `false` (an authentication failure), never an exception, so malformed
 * peer input cannot escape the handshake's cleanup path.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

function checkDeadline(deadline: Deadline): void {
    if (deadline.isExpired()) {
        throw new AuthError("authentication deadline expired", "deadline_expired");
    }
}

function wrapIo(error: unknown): never {
    if (error instanceof AuthError) throw error;
    throw new AuthError("authentication byte I/O failed", "io_failure", error);
}

/** Frame one JSON value as `u32 LE length || UTF-8 body` and write it. */
async function writeMessage(io: AuthByteIo, value: unknown, deadline: Deadline): Promise<void> {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    if (body.length > MAX_AUTH_MESSAGE_LEN) {
        throw new AuthError(
            `outbound auth message of ${body.length} bytes exceeds the ${MAX_AUTH_MESSAGE_LEN}-byte cap`,
            "message_too_large",
        );
    }
    const framed = new Uint8Array(4 + body.length);
    new DataView(framed.buffer).setUint32(0, body.length, true);
    framed.set(body, 4);
    checkDeadline(deadline);
    try {
        await io.write(framed, deadline);
    } catch (error) {
        wrapIo(error);
    }
}

/**
 * Read one framed message. The declared length is validated against the
 * 4,096-byte cap before any body byte is requested or allocated.
 */
async function readMessage(io: AuthByteIo, deadline: Deadline): Promise<unknown> {
    checkDeadline(deadline);
    let prefix: Uint8Array;
    try {
        prefix = await io.readExact(4, deadline);
    } catch (error) {
        wrapIo(error);
    }
    const len = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0, true);
    if (len > MAX_AUTH_MESSAGE_LEN) {
        throw new AuthError(
            `inbound auth message declares ${len} bytes, above the ${MAX_AUTH_MESSAGE_LEN}-byte cap`,
            "message_too_large",
        );
    }
    checkDeadline(deadline);
    let body: Uint8Array;
    try {
        body = len === 0 ? new Uint8Array(0) : await io.readExact(len, deadline);
    } catch (error) {
        wrapIo(error);
    }
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
        throw new AuthError("inbound auth message is not valid UTF-8", "malformed_message");
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new AuthError("inbound auth message is not valid JSON", "malformed_message");
    }
}

interface ServerProofFields {
    daemonId: Uint8Array;
    serverNonce: Uint8Array;
    serverProof: Uint8Array;
    daemonVer: string;
}

/** Exact-length field validation before any conversion or comparison. */
function parseServerProof(message: unknown): ServerProofFields {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
        throw new AuthError("ServerProof message must be a JSON object", "malformed_message");
    }
    const record = message as Record<string, unknown>;
    const daemonId = toExactByteArray(record.daemon_id, AUTH_DAEMON_ID_LEN);
    if (daemonId === null) {
        throw new AuthError(
            `ServerProof daemon_id must be exactly ${AUTH_DAEMON_ID_LEN} integer bytes`,
            "malformed_message",
        );
    }
    const serverNonce = toExactByteArray(record.server_nonce, NONCE_LEN);
    if (serverNonce === null) {
        throw new AuthError(
            `ServerProof server_nonce must be exactly ${NONCE_LEN} integer bytes`,
            "malformed_message",
        );
    }
    const serverProof = toExactByteArray(record.server_proof, PROOF_LEN);
    if (serverProof === null) {
        throw new AuthError(
            `ServerProof server_proof must be exactly ${PROOF_LEN} integer bytes`,
            "malformed_message",
        );
    }
    const daemonVer = record.daemon_ver;
    if (typeof daemonVer !== "string" || daemonVer.length === 0) {
        throw new AuthError(
            "ServerProof daemon_ver must be a nonempty string",
            "malformed_message",
        );
    }
    return { daemonId, serverNonce, serverProof, daemonVer };
}

/**
 * Run the client side of the three-message handshake over `io`, bounded by
 * `deadline`. Emits ClientAuth only after the server proof passed a
 * constant-time comparison AND the server's daemon ID equals
 * `credentials.daemonId`. Any malformed field, proof mismatch, daemon-ID
 * mismatch, EOF, or deadline expiry rejects with a typed {@link AuthError}
 * and writes nothing further.
 */
export async function authenticateClient(
    io: AuthByteIo,
    credentials: { key: Uint8Array; daemonId: Uint8Array },
    deadline: Deadline,
    options: AuthenticateOptions = {},
): Promise<AuthResult> {
    if (
        credentials.key.length !== KEY_BYTE_LEN ||
        credentials.daemonId.length !== AUTH_DAEMON_ID_LEN
    ) {
        throw new AuthError(
            "connection credentials have invalid key or daemon-id length",
            "invalid_credentials",
        );
    }
    const generateNonce = options.generateNonce ?? ((n: number) => new Uint8Array(randomBytes(n)));
    const clientNonce = generateNonce(NONCE_LEN);
    if (clientNonce.length !== NONCE_LEN) {
        throw new AuthError(
            `client nonce generation returned ${clientNonce.length} bytes; expected ${NONCE_LEN}`,
            "invalid_credentials",
        );
    }
    checkDeadline(deadline);
    await writeMessage(io, { client_nonce: Array.from(clientNonce), role: CLIENT_ROLE }, deadline);
    const server = parseServerProof(await readMessage(io, deadline));
    const expectedServerProof = computeProof(
        credentials.key,
        SERVER_PROOF_DOMAIN,
        clientNonce,
        server.serverNonce,
        server.daemonVer,
        server.daemonId,
    );
    if (!constantTimeEqual(expectedServerProof, server.serverProof)) {
        throw new AuthError("server proof verification failed", "proof_mismatch");
    }
    if (!constantTimeEqual(server.daemonId, credentials.daemonId)) {
        throw new AuthError(
            "server daemon id does not match the connection file",
            "daemon_id_mismatch",
        );
    }
    const clientAuth = computeProof(
        credentials.key,
        CLIENT_AUTH_DOMAIN,
        clientNonce,
        server.serverNonce,
        server.daemonVer,
        server.daemonId,
    );
    await writeMessage(io, { client_auth: Array.from(clientAuth) }, deadline);
    return { daemonVer: server.daemonVer, daemonId: server.daemonId.slice() };
}
