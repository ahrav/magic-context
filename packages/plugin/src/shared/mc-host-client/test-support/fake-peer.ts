/**
 * The peer provides an independent in-process TCP server for adversarial connection tests.
 *
 * The peer implements the server side of the wire document's Section 5 authentication handshake.
 * The peer imports no production-client modules.
 * A passing test demonstrates interoperability rather than shared implementation behavior.
 * Node 24.
 */

import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export const PEER_HEADER_LEN = 21;
export const PEER_PROTOCOL_VERSION = 2;

/** The frame type bytes duplicate the wire document, not `protocol.ts`. */
export const PeerFrameType = {
    Request: 0,
    Response: 1,
    Push: 2,
    StreamData: 3,
    StreamEnd: 4,
    Error: 5,
    Cancel: 6,
    Ping: 7,
    Pong: 8,
    Hello: 9,
    HelloAck: 10,
    Goodbye: 11,
} as const;

export interface PeerFrameFields {
    ty: number;
    flags?: number;
    channel?: number;
    epoch?: number;
    corr?: bigint;
    body?: Uint8Array;
    /** `len` and `ver` override the encoded length and `PEER_PROTOCOL_VERSION` for malformed frames. */
    len?: number;
    ver?: number;
}

/** The peer's independent decoder produces this frame. */
export interface PeerFrame {
    len: number;
    ver: number;
    ty: number;
    flags: number;
    channel: number;
    epoch: number;
    corr: bigint;
    body: Buffer;
}

/* */
export function encodePeerFrame(fields: PeerFrameFields): Buffer {
    const body = fields.body ? Buffer.from(fields.body) : Buffer.alloc(0);
    const buf = Buffer.alloc(PEER_HEADER_LEN + body.length);
    buf.writeUInt32LE(fields.len ?? body.length, 0);
    buf.writeUInt8(fields.ver ?? PEER_PROTOCOL_VERSION, 4);
    buf.writeUInt8(fields.ty, 5);
    buf.writeUInt8(fields.flags ?? 0, 6);
    buf.writeUInt16LE(fields.channel ?? 0, 7);
    buf.writeUInt32LE(fields.epoch ?? 0, 9);
    buf.writeBigUInt64LE(fields.corr ?? 0n, 13);
    body.copy(buf, PEER_HEADER_LEN);
    return buf;
}

/* */
export function encodePeerAuthMessage(value: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    const framed = Buffer.alloc(4 + body.length);
    framed.writeUInt32LE(body.length, 0);
    body.copy(framed, 4);
    return framed;
}

function hmacProof(
    key: Buffer,
    domain: string,
    clientNonce: Buffer,
    serverNonce: Buffer,
    daemonVer: string,
    daemonId: Buffer,
): Buffer {
    const daemonVerBytes = Buffer.from(daemonVer, "utf8");
    const daemonVerLen = Buffer.allocUnsafe(4);
    daemonVerLen.writeUInt32BE(daemonVerBytes.length);
    return createHmac("sha256", key)
        .update(Buffer.from(domain, "ascii"))
        .update(clientNonce)
        .update(serverNonce)
        .update(daemonVerLen)
        .update(daemonVerBytes)
        .update(daemonId)
        .digest();
}

export type PeerAuthMode = "accept" | "wrong-proof" | "malformed" | "stall" | "destroy-on-hello";

/* */
export type PeerNegotiateResponder = (frame: PeerFrame, connection: FakePeerConnection) => void;

/**
 *
 * `echo-tcp` responds with TCP and the offered TCP capability version, or `1` if absent, without a fallback reason.
 * `unsupported-op` sends an Error frame with code `unsupported_operation`.
 * `silent` records the frame without responding.
 */
export type PeerNegotiateMode = "echo-tcp" | "unsupported-op" | "silent" | PeerNegotiateResponder;

export interface FakePeerOptions {
    authMode?: PeerAuthMode;
    key?: Buffer;
    daemonId?: Buffer;
    daemonVer?: string;
    negotiate?: PeerNegotiateMode;
}

export interface PeerSendOptions {
    /** `splits` separates outgoing bytes at these byte offsets. */
    splits?: number[];
    /** `delayMs` delays split writes by this many milliseconds. */
    delayMs?: number;
}

interface FrameWaiter {
    check: () => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 */
export class FakePeerConnection {
    readonly socket: Socket;
    /** The peer records parsed auth JSON messages from the client in arrival order. */
    readonly authMessages: unknown[] = [];
    /** The peer records post-auth frames from its independent decoder in decode order. */
    readonly frames: PeerFrame[] = [];
    /** The peer sets the misalignment flag when its decoder loses stream alignment. */
    corruption: Error | null = null;
    /** The peer uses the ClientAuth proof verdict only in tests, so the comparison need not be constant-time. */
    clientAuthValid: boolean | null = null;
    readonly closed: Promise<void>;
    receivedBytes = 0;

    private stage: "auth-hello" | "auth-client" | "frames" | "dead" = "auth-hello";
    private buffer = Buffer.alloc(0);
    private clientNonce: Buffer | null = null;
    private serverNonce: Buffer | null = null;
    private readonly waiters: FrameWaiter[] = [];
    private resolveAuthed!: () => void;
    private rejectAuthed!: (error: Error) => void;
    readonly authenticated: Promise<void>;

    constructor(
        socket: Socket,
        private readonly options: Required<Pick<FakePeerOptions, "authMode" | "daemonVer">> & {
            key: Buffer;
            daemonId: Buffer;
            /** The peer samples the ServerHello value at ServerHello time, allowing tests to change the value per dial. */
            helloTrailer: () => Buffer | null;
            /** The peer reads the negotiation mode once for each decoded `transport.negotiate` request. */
            negotiate: () => PeerNegotiateMode;
        },
    ) {
        this.socket = socket;
        this.authenticated = new Promise((resolve, reject) => {
            this.resolveAuthed = resolve;
            this.rejectAuthed = reject;
        });
        this.authenticated.catch(() => {});
        this.closed = new Promise((resolve) => {
            socket.on("close", () => {
                this.rejectAuthed(new Error("peer connection closed before auth completed"));
                resolve();
            });
        });
        socket.on("error", () => {
            // The peer expects client-side resets during adversarial runs.
        });
        socket.on("data", (chunk: Buffer) => this.onData(chunk));
    }

    private onData(chunk: Buffer): void {
        this.receivedBytes += chunk.length;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.parse();
    }

    private parse(): void {
        for (;;) {
            if (this.stage === "dead") return;
            if (this.stage === "auth-hello" || this.stage === "auth-client") {
                const message = this.takeAuthMessage();
                if (message === undefined) return;
                this.authMessages.push(message);
                if (this.stage === "auth-hello") {
                    this.onClientHello(message);
                } else {
                    this.onClientAuth(message);
                }
                continue;
            }
            if (this.buffer.length < PEER_HEADER_LEN) return;
            const len = this.buffer.readUInt32LE(0);
            const ver = this.buffer.readUInt8(4);
            if (ver !== PEER_PROTOCOL_VERSION) {
                this.corruption = new Error(
                    `peer decoder lost alignment: version byte ${ver} at frame ${this.frames.length}`,
                );
                this.stage = "dead";
                this.notifyWaiters();
                return;
            }
            if (this.buffer.length < PEER_HEADER_LEN + len) return;
            const frame: PeerFrame = {
                len,
                ver,
                ty: this.buffer.readUInt8(5),
                flags: this.buffer.readUInt8(6),
                channel: this.buffer.readUInt16LE(7),
                epoch: this.buffer.readUInt32LE(9),
                corr: this.buffer.readBigUInt64LE(13),
                body: Buffer.from(this.buffer.subarray(PEER_HEADER_LEN, PEER_HEADER_LEN + len)),
            };
            this.buffer = this.buffer.subarray(PEER_HEADER_LEN + len);
            this.frames.push(frame);
            this.maybeServeNegotiate(frame);
            this.notifyWaiters();
        }
    }

    /** The peer parses request bodies with `JSON.parse`, not the production-client decoder. */
    private maybeServeNegotiate(frame: PeerFrame): void {
        if (frame.ty !== PeerFrameType.Request || frame.channel !== 0) return;
        let parsed: { op?: unknown; offers?: unknown } | undefined;
        try {
            parsed = JSON.parse(frame.body.toString("utf8")) as { op?: unknown; offers?: unknown };
        } catch {
            return;
        }
        if (parsed?.op !== "transport.negotiate") return;
        const mode = this.options.negotiate();
        if (mode === "silent") return;
        if (typeof mode === "function") {
            mode(frame, this);
            return;
        }
        if (mode === "unsupported-op") {
            this.socket.write(
                encodePeerFrame({
                    ty: PeerFrameType.Error,
                    corr: frame.corr,
                    body: Buffer.from(
                        JSON.stringify({
                            code: "unsupported_operation",
                            message: "unknown control operation",
                        }),
                        "utf8",
                    ),
                }),
            );
            return;
        }
        const offers = Array.isArray(parsed.offers) ? parsed.offers : [];
        const tcp = offers.find(
            (offer) => (offer as { transport?: unknown })?.transport === "tcp",
        ) as { capability_version?: number } | undefined;
        this.socket.write(
            encodePeerFrame({
                ty: PeerFrameType.Response,
                corr: frame.corr,
                body: Buffer.from(
                    JSON.stringify({
                        op: "transport.negotiate",
                        negotiation_version: 1,
                        selected: {
                            transport: "tcp",
                            capability_version: tcp?.capability_version ?? 1,
                        },
                    }),
                    "utf8",
                ),
            }),
        );
    }

    private takeAuthMessage(): unknown | undefined {
        if (this.buffer.length < 4) return undefined;
        const len = this.buffer.readUInt32LE(0);
        if (this.buffer.length < 4 + len) return undefined;
        const body = this.buffer.subarray(4, 4 + len);
        this.buffer = this.buffer.subarray(4 + len);
        try {
            return JSON.parse(body.toString("utf8"));
        } catch (error) {
            this.corruption =
                error instanceof Error ? error : new Error("invalid auth message JSON");
            this.stage = "dead";
            this.notifyWaiters();
            return undefined;
        }
    }

    private onClientHello(message: unknown): void {
        const hello = message as { client_nonce?: number[] };
        this.clientNonce = Buffer.from(hello.client_nonce ?? []);
        switch (this.options.authMode) {
            case "destroy-on-hello":
                this.stage = "dead";
                this.socket.destroy();
                return;
            case "stall":
                this.stage = "dead";
                return;
            case "malformed":
                this.stage = "auth-client";
                this.socket.write(encodePeerAuthMessage({ nonsense: true }));
                return;
            case "wrong-proof":
            case "accept": {
                this.serverNonce = randomBytes(32);
                const proof = hmacProof(
                    this.options.key,
                    "subc-server-v1",
                    this.clientNonce,
                    this.serverNonce,
                    this.options.daemonVer,
                    this.options.daemonId,
                );
                if (this.options.authMode === "wrong-proof") {
                    proof[0] = (proof[0] as number) ^ 0x01;
                }
                this.stage = "auth-client";
                const hello = encodePeerAuthMessage({
                    daemon_id: Array.from(this.options.daemonId),
                    server_nonce: Array.from(this.serverNonce),
                    daemon_ver: this.options.daemonVer,
                    server_proof: Array.from(proof),
                });
                // The trailer shares the `ServerHello` write so setup processes it before returning.
                // The `ServerHello` trailer frame dispatches before setup returns.
                const trailer = this.options.helloTrailer();
                this.socket.write(trailer ? Buffer.concat([hello, trailer]) : hello);
                return;
            }
        }
    }

    private onClientAuth(message: unknown): void {
        const auth = message as { client_auth?: number[] };
        const received = Buffer.from(auth.client_auth ?? []);
        const expected =
            this.clientNonce && this.serverNonce
                ? hmacProof(
                      this.options.key,
                      "subc-client-v1",
                      this.clientNonce,
                      this.serverNonce,
                      this.options.daemonVer,
                      this.options.daemonId,
                  )
                : Buffer.alloc(0);
        this.clientAuthValid = received.length === expected.length && received.equals(expected);
        this.stage = "frames";
        this.resolveAuthed();
        this.parse();
    }

    private notifyWaiters(): void {
        for (let i = this.waiters.length - 1; i >= 0; i--) {
            const waiter = this.waiters[i] as FrameWaiter;
            if (this.corruption) {
                this.waiters.splice(i, 1);
                clearTimeout(waiter.timer);
                waiter.reject(this.corruption);
                continue;
            }
            if (waiter.check()) {
                this.waiters.splice(i, 1);
                clearTimeout(waiter.timer);
                waiter.resolve();
            }
        }
    }

    /* */
    waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
        if (this.corruption) return Promise.reject(this.corruption);
        if (check()) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const waiter: FrameWaiter = {
                check,
                resolve,
                reject,
                timer: setTimeout(() => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) this.waiters.splice(index, 1);
                    reject(
                        new Error(
                            `fake peer timed out waiting for frames; have ${this.frames.length}`,
                        ),
                    );
                }, timeoutMs),
            };
            this.waiters.push(waiter);
        });
    }

    waitForFrameCount(count: number, timeoutMs = 5_000): Promise<void> {
        return this.waitFor(() => this.frames.length >= count, timeoutMs);
    }

    /* */
    async sendRaw(bytes: Buffer, options: PeerSendOptions = {}): Promise<void> {
        const splits = [...(options.splits ?? [])].sort((a, b) => a - b);
        const parts: Buffer[] = [];
        let start = 0;
        for (const split of splits) {
            if (split <= start || split >= bytes.length) continue;
            parts.push(bytes.subarray(start, split));
            start = split;
        }
        parts.push(bytes.subarray(start));
        for (let i = 0; i < parts.length; i++) {
            if (i > 0 && options.delayMs !== undefined) await delay(options.delayMs);
            if (this.socket.destroyed) return;
            this.socket.write(parts[i] as Buffer);
        }
    }

    send(fields: PeerFrameFields, options: PeerSendOptions = {}): Promise<void> {
        return this.sendRaw(encodePeerFrame(fields), options);
    }

    /** The peer pauses the socket to apply backpressure. */
    pauseReading(): void {
        this.socket.pause();
    }

    resumeReading(): void {
        this.socket.resume();
    }

    /* */
    destroy(): void {
        this.stage = "dead";
        this.socket.destroy();
    }

    /**
     * `reset()` calls `resetAndDestroy()` when available to force an RST; `destroy()` can instead produce EOF.
     * `destroy()` can close with a FIN, which the client classifies as EOF.
     * Tests requiring a socket-failure classification need an RST.
     */
    reset(): void {
        this.stage = "dead";
        const socket = this.socket as Socket & { resetAndDestroy?: () => void };
        if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
        else socket.destroy();
    }

    /** `end()` sends an orderly FIN toward the client. */
    end(): void {
        this.socket.end();
    }
}

/** `FakePeer` provides an in-process TCP peer with scripted server-side auth and frame behavior. */
export class FakePeer {
    readonly connections: FakePeerConnection[] = [];
    readonly key: Buffer;
    readonly daemonId: Buffer;
    /** `daemonVer` is the `daemon_ver` reported in every `ServerProof`. */
    readonly daemonVer: string;
    /**
     * `helloTrailer` appends raw bytes to every subsequent `ServerHello` write; tests can enable it after an initial clean connection.
     */
    helloTrailer: Buffer | null = null;
    negotiateMode: PeerNegotiateMode;

    private readonly server: Server;
    private readonly connectionWaiters: ((connection: FakePeerConnection) => void)[] = [];

    private constructor(
        server: Server,
        readonly port: number,
        options: FakePeerOptions,
    ) {
        this.server = server;
        this.key = options.key ?? randomBytes(32);
        this.daemonId = options.daemonId ?? randomBytes(16);
        this.daemonVer = options.daemonVer ?? "fake-peer/0.0.1";
        this.negotiateMode = options.negotiate ?? "echo-tcp";
        const connectionOptions = {
            authMode: options.authMode ?? ("accept" as PeerAuthMode),
            daemonVer: this.daemonVer,
            key: this.key,
            daemonId: this.daemonId,
            helloTrailer: () => this.helloTrailer,
            negotiate: () => this.negotiateMode,
        };
        server.on("connection", (socket: Socket) => {
            const connection = new FakePeerConnection(socket, connectionOptions);
            this.connections.push(connection);
            const waiter = this.connectionWaiters.shift();
            waiter?.(connection);
        });
    }

    static start(options: FakePeerOptions = {}): Promise<FakePeer> {
        return new Promise((resolve, reject) => {
            const server = createServer();
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (address === null || typeof address === "string") {
                    reject(new Error("fake peer failed to bind a TCP port"));
                    return;
                }
                resolve(new FakePeer(server, address.port, options));
            });
        });
    }

    waitForConnection(timeoutMs = 5_000): Promise<FakePeerConnection> {
        // `waitForConnection()` skips destroyed sockets because `connections` can end with a closed connection after a client reconnects.
        for (let i = this.connections.length - 1; i >= 0; i--) {
            const candidate = this.connections[i];
            if (candidate && !candidate.socket.destroyed) return Promise.resolve(candidate);
        }
        return new Promise((resolve, reject) => {
            const waiter = (connection: FakePeerConnection): void => {
                clearTimeout(timer);
                resolve(connection);
            };
            const timer = setTimeout(() => {
                // The timeout callback removes an expired waiter so it cannot consume a later connection before a live waiter.
                const index = this.connectionWaiters.indexOf(waiter);
                if (index >= 0) this.connectionWaiters.splice(index, 1);
                reject(new Error("fake peer timed out waiting for a connection"));
            }, timeoutMs);
            this.connectionWaiters.push(waiter);
        });
    }

    /**
     * `waitForConnectionAfter()` resolves with the connection at zero-based accept index `count`.
     * `waitForConnectionAfter(connections.length)` resolves the next accepted connection.
     */
    waitForConnectionAfter(count: number, timeoutMs = 5_000): Promise<FakePeerConnection> {
        const existing = this.connections[count];
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const waiter = (): void => {
                const target = this.connections[count];
                if (!target) {
                    this.connectionWaiters.push(waiter);
                    return;
                }
                clearTimeout(timer);
                resolve(target);
            };
            const timer = setTimeout(() => {
                const index = this.connectionWaiters.indexOf(waiter);
                if (index >= 0) this.connectionWaiters.splice(index, 1);
                reject(new Error("fake peer timed out waiting for a connection"));
            }, timeoutMs);
            this.connectionWaiters.push(waiter);
        });
    }

    async close(): Promise<void> {
        for (const connection of this.connections) {
            connection.destroy();
        }
        await new Promise<void>((resolve) => {
            this.server.close(() => resolve());
        });
    }
}
