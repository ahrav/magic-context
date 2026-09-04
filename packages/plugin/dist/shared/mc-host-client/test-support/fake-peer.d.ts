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
import { type Socket } from "node:net";
export declare const PEER_HEADER_LEN = 21;
export declare const PEER_PROTOCOL_VERSION = 2;
/** Frame type bytes duplicated from the wire doc, not from protocol.ts. */
export declare const PeerFrameType: {
    readonly Request: 0;
    readonly Response: 1;
    readonly Push: 2;
    readonly StreamData: 3;
    readonly StreamEnd: 4;
    readonly Error: 5;
    readonly Cancel: 6;
    readonly Ping: 7;
    readonly Pong: 8;
    readonly Hello: 9;
    readonly HelloAck: 10;
    readonly Goodbye: 11;
};
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
export declare function encodePeerFrame(fields: PeerFrameFields): Buffer;
/** `u32 LE length || UTF-8 JSON` auth message framing (wire doc 5.1). */
export declare function encodePeerAuthMessage(value: unknown): Buffer;
export type PeerAuthMode = "accept" | "wrong-proof" | "malformed" | "stall" | "destroy-on-hello";
/** The callback controls the response to one decoded `transport.negotiate` request. */
export type PeerNegotiateResponder = (frame: PeerFrame, connection: FakePeerConnection) => void;
/**
 * The peer uses this mode to answer a client `transport.negotiate` request.
 *
 * - `echo-tcp` (default): respond with TCP and the offered TCP capability
 *   version, or `1` when absent, with no fallback reason.
 * - `unsupported-op`: send an Error frame with code `unsupported_operation`.
 * - `silent`: record the frame without responding.
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
    /** Byte offsets at which to split the outgoing bytes into separate writes. */
    splits?: number[];
    /** Delay between split writes, in milliseconds. */
    delayMs?: number;
}
/**
 * One accepted connection: server-side auth transcript, an independent
 * ingress frame decoder that records every byte and flags misalignment,
 * scripted egress (fragmented/coalesced/delayed writes), backpressure
 * (stop reading), and immediate destroy/reset.
 */
export declare class FakePeerConnection {
    private readonly options;
    readonly socket: Socket;
    /** Parsed auth JSON messages received from the client, in order. */
    readonly authMessages: unknown[];
    /** Frames decoded post-auth by the peer's own decoder, in order. */
    readonly frames: PeerFrame[];
    /** Set when the peer's decoder loses stream alignment. */
    corruption: Error | null;
    /** Constant-time-irrelevant test verdict on the ClientAuth proof. */
    clientAuthValid: boolean | null;
    readonly closed: Promise<void>;
    receivedBytes: number;
    private stage;
    private buffer;
    private clientNonce;
    private serverNonce;
    private readonly waiters;
    private resolveAuthed;
    private rejectAuthed;
    readonly authenticated: Promise<void>;
    constructor(socket: Socket, options: Required<Pick<FakePeerOptions, "authMode" | "daemonVer">> & {
        key: Buffer;
        daemonId: Buffer;
        /** Sampled at ServerHello time so tests can flip it per dial. */
        helloTrailer: () => Buffer | null;
        /** Read once per decoded `transport.negotiate` request. */
        negotiate: () => PeerNegotiateMode;
    });
    private onData;
    private parse;
    /** Parses request bodies with plain `JSON.parse`, never the production client decoder. */
    private maybeServeNegotiate;
    private takeAuthMessage;
    private onClientHello;
    private onClientAuth;
    private notifyWaiters;
    /** Wait until `check()` over the recorded frames passes. */
    waitFor(check: () => boolean, timeoutMs?: number): Promise<void>;
    waitForFrameCount(count: number, timeoutMs?: number): Promise<void>;
    /** Write raw bytes, optionally fragmented at `splits` with delays. */
    sendRaw(bytes: Buffer, options?: PeerSendOptions): Promise<void>;
    send(fields: PeerFrameFields, options?: PeerSendOptions): Promise<void>;
    /** Backpressure: stop consuming the client's bytes. */
    pauseReading(): void;
    resumeReading(): void;
    /** Immediate destroy (RST-style reset toward the client). */
    destroy(): void;
    /**
     * Deterministic RST toward the client. `destroy()` without an error can
     * close with an ordinary FIN, which the client reads as `eof`; tests
     * asserting a socket-failure classification need a real reset. Falls
     * back to `destroy()` on runtimes without `resetAndDestroy`.
     */
    reset(): void;
    /** Orderly FIN toward the client. */
    end(): void;
}
/** In-process TCP peer with scripted server-side auth and frame behavior. */
export declare class FakePeer {
    readonly port: number;
    readonly connections: FakePeerConnection[];
    readonly key: Buffer;
    readonly daemonId: Buffer;
    /** The `daemon_ver` this peer reports in every ServerProof. */
    readonly daemonVer: string;
    /**
     * Raw bytes coalesced into the same write as every subsequent
     * ServerHello (for example an encoded Goodbye frame), so the client's
     * setup retires synchronously before it returns. Mutable so a test can
     * enable it after an initial clean connection.
     */
    helloTrailer: Buffer | null;
    negotiateMode: PeerNegotiateMode;
    private readonly server;
    private readonly connectionWaiters;
    private constructor();
    static start(options?: FakePeerOptions): Promise<FakePeer>;
    waitForConnection(timeoutMs?: number): Promise<FakePeerConnection>;
    /**
     * Resolve with the connection at zero-based accept index `count`.
     * Called with the current `connections.length`, this is exactly the
     * next accepted connection, regardless of whether earlier peer-side
     * sockets have observed their destruction yet — the guarantee
     * `waitForConnection`'s newest-live selection cannot give.
     */
    waitForConnectionAfter(count: number, timeoutMs?: number): Promise<FakePeerConnection>;
    close(): Promise<void>;
}
//# sourceMappingURL=fake-peer.d.ts.map