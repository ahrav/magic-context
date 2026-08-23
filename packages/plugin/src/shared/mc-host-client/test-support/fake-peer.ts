/**
 * Independent in-process TCP peer for adversarial connection tests.
 *
 * Implements the SERVER side of the wire doc's auth handshake (Section 5)
 * and v2 frame encoding (Section 6) with its own encoders and decoder. It
 * deliberately imports nothing from the production client (`protocol.ts`,
 * `auth.ts`, ...), so a green test proves interoperability rather than
 * self-consistency (wire doc 14.1). Runtime-neutral: `node:net`,
 * `node:crypto`, and timers only, so the same peer runs under Bun and
 * Node 24.
 */

import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export const PEER_HEADER_LEN = 21;
export const PEER_PROTOCOL_VERSION = 2;

/** Frame type bytes duplicated from the wire doc, not from protocol.ts. */
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
    /** Overrides for malformed frames; default to the true values. */
    len?: number;
    ver?: number;
}

/** One frame decoded by the peer's own independent decoder. */
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

/** Encode one v2 frame with the peer's own little-endian layout. */
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

/** `u32 LE length || UTF-8 JSON` auth message framing (wire doc 5.1). */
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
    daemonId: Buffer,
): Buffer {
    return createHmac("sha256", key)
        .update(Buffer.from(domain, "ascii"))
        .update(clientNonce)
        .update(serverNonce)
        .update(daemonId)
        .digest();
}

export type PeerAuthMode = "accept" | "wrong-proof" | "malformed" | "stall" | "destroy-on-hello";

export interface FakePeerOptions {
    authMode?: PeerAuthMode;
    key?: Buffer;
    daemonId?: Buffer;
    daemonVer?: string;
}

export interface PeerSendOptions {
    /** Byte offsets at which to split the outgoing bytes into separate writes. */
    splits?: number[];
    /** Delay between split writes, in milliseconds. */
    delayMs?: number;
}

interface FrameWaiter {
    check: () => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * One accepted connection: server-side auth transcript, an independent
 * ingress frame decoder that records every byte and flags misalignment,
 * scripted egress (fragmented/coalesced/delayed writes), backpressure
 * (stop reading), and immediate destroy/reset.
 */
export class FakePeerConnection {
    readonly socket: Socket;
    /** Parsed auth JSON messages received from the client, in order. */
    readonly authMessages: unknown[] = [];
    /** Frames decoded post-auth by the peer's own decoder, in order. */
    readonly frames: PeerFrame[] = [];
    /** Set when the peer's decoder loses stream alignment. */
    corruption: Error | null = null;
    /** Constant-time-irrelevant test verdict on the ClientAuth proof. */
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
            /** Sampled at ServerHello time so tests can flip it per dial. */
            helloTrailer: () => Buffer | null;
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
            // Resets from the client side are expected in adversarial runs.
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
            // Frame stage: the peer's own incremental decoder.
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
            this.notifyWaiters();
        }
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
                // A trailer rides the same write as the ServerHello, so the
                // client sees both in one read chunk: auth completes and the
                // trailer frame dispatches before setup returns.
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

    /** Wait until `check()` over the recorded frames passes. */
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

    /** Write raw bytes, optionally fragmented at `splits` with delays. */
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

    /** Backpressure: stop consuming the client's bytes. */
    pauseReading(): void {
        this.socket.pause();
    }

    resumeReading(): void {
        this.socket.resume();
    }

    /** Immediate destroy (RST-style reset toward the client). */
    destroy(): void {
        this.stage = "dead";
        this.socket.destroy();
    }

    /** Orderly FIN toward the client. */
    end(): void {
        this.socket.end();
    }
}

/** In-process TCP peer with scripted server-side auth and frame behavior. */
export class FakePeer {
    readonly connections: FakePeerConnection[] = [];
    readonly key: Buffer;
    readonly daemonId: Buffer;
    /**
     * Raw bytes coalesced into the same write as every subsequent
     * ServerHello (for example an encoded Goodbye frame), so the client's
     * setup retires synchronously before it returns. Mutable so a test can
     * enable it after an initial clean connection.
     */
    helloTrailer: Buffer | null = null;

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
        const connectionOptions = {
            authMode: options.authMode ?? ("accept" as PeerAuthMode),
            daemonVer: options.daemonVer ?? "fake-peer/0.0.1",
            key: this.key,
            daemonId: this.daemonId,
            helloTrailer: () => this.helloTrailer,
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
        // Skip destroyed sockets: after a client reconnect, the last entry
        // can be the closed prior connection rather than the new one.
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
                // Remove the expired waiter so it cannot consume the next
                // connection ahead of a live waiter.
                const index = this.connectionWaiters.indexOf(waiter);
                if (index >= 0) this.connectionWaiters.splice(index, 1);
                reject(new Error("fake peer timed out waiting for a connection"));
            }, timeoutMs);
            this.connectionWaiters.push(waiter);
        });
    }

    /**
     * Resolve with the connection at zero-based accept index `count`.
     * Called with the current `connections.length`, this is exactly the
     * next accepted connection, regardless of whether earlier peer-side
     * sockets have observed their destruction yet — the guarantee
     * `waitForConnection`'s newest-live selection cannot give.
     */
    waitForConnectionAfter(count: number, timeoutMs = 5_000): Promise<FakePeerConnection> {
        const existing = this.connections[count];
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const waiter = (): void => {
                const target = this.connections[count];
                if (!target) {
                    // Accepts before the requested index re-arm the waiter.
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
