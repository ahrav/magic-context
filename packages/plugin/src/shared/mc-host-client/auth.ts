/**
 *
 *
 * Authentication errors do not include key, nonce, or proof bytes in their messages.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { toExactByteArray } from "./bytes";
import type { Deadline } from "./deadline";

export const NONCE_LEN = 32;
export const PROOF_LEN = 32;
const KEY_BYTE_LEN = 32;
export const AUTH_DAEMON_ID_LEN = 16;
/** Messages longer than 4,096 bytes are rejected. */
export const MAX_AUTH_MESSAGE_LEN = 4_096;
export const SERVER_PROOF_DOMAIN = "subc-server-v1";
export const CLIENT_AUTH_DOMAIN = "subc-client-v1";
export const CLIENT_ROLE = "client";

/**
 * Implementations must resolve readExact only with exactly n bytes and reject on EOF, I/O error, or deadline expiry.
 * write must reject unless every byte was accepted for transmission.
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
    | "daemon_ver_mismatch"
    | "invalid_credentials";

/* */
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
    /** Tests can inject generateNonce; production defaults to randomBytes. */
    generateNonce?: (length: number) => Uint8Array;
}

/**
 *
 * The peer must report credentials.daemonVer.
 * daemonVer is required because every handshake validates the peer's reported version against it.
 * A caller without an expected daemon version cannot establish an authenticated connection.
 */
export interface AuthCredentials {
    key: Uint8Array;
    daemonId: Uint8Array;
    daemonVer: string;
}

/* */
export interface AuthResult {
    /**
     * The server-reported daemon version always equals credentials.daemonVer.
     * Any other value fails the handshake.
     */
    daemonVer: string;
    daemonId: Uint8Array;
}

/**
 * The export lets tests reproduce literal proof vectors independently of transcript construction.
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
 * A length mismatch returns `false` rather than throwing.
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

/* */
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
 * The parser validates the declared length before requesting the body.
 * The parser validates the declared length against the 4,096-byte cap before requesting or allocating the body.
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

/* */
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
 * `ClientAuth` is emitted only after the server proof passes constant-time comparison.
 * Malformed fields and authentication mismatches reject with `AuthError`.
 * EOF and deadline expiry reject with `AuthError`.
 * Authentication failures reject with `AuthError` and write no further messages.
 */
export async function authenticateClient(
    io: AuthByteIo,
    credentials: AuthCredentials,
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
    // The server proof authenticates `daemon_ver`.
    if (server.daemonVer !== credentials.daemonVer) {
        throw new AuthError(
            "server daemon version does not match the connection file",
            "daemon_ver_mismatch",
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
