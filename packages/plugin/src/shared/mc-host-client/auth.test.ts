import { describe, expect, test } from "bun:test";
import { type AuthByteIo, AuthError, authenticateClient, computeProof } from "./auth";
import { Deadline, type MonotonicClock } from "./deadline";

/**
 * Committed literal vectors from `docs/mc-host-wire-protocol.md` Section
 * 5.2: key bytes 00..1f, client nonce 20..3f, server nonce 40..5f, daemon
 * ID 60..6f. Expected proof bytes are hardcoded from the document; they are
 * never generated with the code under test.
 */
function byteRange(start: number, end: number): Uint8Array {
    return Uint8Array.from({ length: end - start }, (_, i) => start + i);
}

const KEY = byteRange(0x00, 0x20);
const CLIENT_NONCE = byteRange(0x20, 0x40);
const SERVER_NONCE = byteRange(0x40, 0x60);
const DAEMON_ID = byteRange(0x60, 0x70);
const DAEMON_VER = "mc-host/0.1.0";

const SERVER_PROOF_LITERAL = Uint8Array.from([
    64, 154, 84, 68, 23, 100, 116, 189, 2, 121, 137, 79, 177, 172, 107, 52, 108, 174, 152, 208, 218,
    25, 249, 160, 154, 212, 42, 68, 91, 108, 85, 131,
]);
const CLIENT_AUTH_LITERAL = Uint8Array.from([
    184, 138, 243, 55, 0, 189, 88, 52, 54, 27, 4, 112, 129, 214, 202, 57, 252, 146, 75, 221, 119,
    177, 247, 0, 193, 206, 206, 26, 90, 147, 247, 187,
]);

function fakeClock(startMs = 0): { clock: MonotonicClock; advance: (ms: number) => void } {
    let now = startMs;
    return {
        clock: () => now,
        advance: (ms: number) => {
            now += ms;
        },
    };
}

function farDeadline(): Deadline {
    return Deadline.start(60_000, fakeClock().clock);
}

/** Frame `u32 LE length || body` exactly as wire doc Section 5.1 requires. */
function frame(body: Uint8Array): Uint8Array {
    const framed = new Uint8Array(4 + body.length);
    new DataView(framed.buffer).setUint32(0, body.length, true);
    framed.set(body, 4);
    return framed;
}

function frameJson(value: unknown, padToLength?: number): Uint8Array {
    let text = JSON.stringify(value);
    if (padToLength !== undefined) {
        if (text.length > padToLength) throw new Error("test payload larger than pad target");
        text = text.padEnd(padToLength, " ");
    }
    return frame(new TextEncoder().encode(text));
}

function serverProofMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        daemon_id: Array.from(DAEMON_ID),
        server_nonce: Array.from(SERVER_NONCE),
        daemon_ver: DAEMON_VER,
        server_proof: Array.from(SERVER_PROOF_LITERAL),
        ...overrides,
    };
}

/**
 * Deterministic in-memory byte I/O. Records every write and every readExact
 * request size so tests can assert that no ClientAuth was written and that
 * an oversize declaration was rejected before any body read.
 */
class FakeIo implements AuthByteIo {
    readonly writes: Uint8Array[] = [];
    readonly readRequests: number[] = [];
    private offset = 0;

    constructor(
        private readonly inbound: Uint8Array = new Uint8Array(0),
        private readonly onIo?: () => void,
    ) {}

    async readExact(n: number, _deadline: Deadline): Promise<Uint8Array> {
        this.readRequests.push(n);
        this.onIo?.();
        if (this.offset + n > this.inbound.length) {
            throw new Error("unexpected EOF");
        }
        const bytes = this.inbound.subarray(this.offset, this.offset + n);
        this.offset += n;
        return bytes;
    }

    async write(bytes: Uint8Array, _deadline: Deadline): Promise<void> {
        this.onIo?.();
        this.writes.push(bytes.slice());
    }
}

function decodeWrite(bytes: Uint8Array): unknown {
    const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    expect(len).toBe(bytes.length - 4);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4)));
}

const injectedNonce = { generateNonce: () => CLIENT_NONCE.slice() };

async function expectAuthFailure(
    io: FakeIo,
    code: AuthError["code"],
    deadline: Deadline = farDeadline(),
): Promise<void> {
    const attempt = authenticateClient(
        io,
        { key: KEY, daemonId: DAEMON_ID, daemonVer: DAEMON_VER },
        deadline,
        {
            ...injectedNonce,
        },
    );
    const error = await attempt.then(
        () => {
            throw new Error("authentication unexpectedly succeeded");
        },
        (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(code);
    // The failure must leave at most the ClientHello on the wire: a second
    // write would be a ClientAuth emitted after a failed check.
    expect(io.writes.length).toBeLessThanOrEqual(1);
}

describe("computeProof literal vectors", () => {
    test("reproduces the committed server proof", () => {
        const proof = computeProof(
            KEY,
            "subc-server-v1",
            CLIENT_NONCE,
            SERVER_NONCE,
            DAEMON_VER,
            DAEMON_ID,
        );
        expect(Array.from(proof)).toEqual(Array.from(SERVER_PROOF_LITERAL));
    });

    test("reproduces the committed client auth proof", () => {
        const proof = computeProof(
            KEY,
            "subc-client-v1",
            CLIENT_NONCE,
            SERVER_NONCE,
            DAEMON_VER,
            DAEMON_ID,
        );
        expect(Array.from(proof)).toEqual(Array.from(CLIENT_AUTH_LITERAL));
    });

    test("every input perturbation changes the proof", () => {
        const flip = (bytes: Uint8Array): Uint8Array => {
            const copy = bytes.slice();
            copy[0] = (copy[0] as number) ^ 0x01;
            return copy;
        };
        const baseline = Array.from(
            computeProof(KEY, "subc-server-v1", CLIENT_NONCE, SERVER_NONCE, DAEMON_VER, DAEMON_ID),
        );
        const perturbed = [
            computeProof(
                flip(KEY),
                "subc-server-v1",
                CLIENT_NONCE,
                SERVER_NONCE,
                DAEMON_VER,
                DAEMON_ID,
            ),
            computeProof(KEY, "subc-client-v1", CLIENT_NONCE, SERVER_NONCE, DAEMON_VER, DAEMON_ID),
            computeProof(
                KEY,
                "subc-server-v1",
                flip(CLIENT_NONCE),
                SERVER_NONCE,
                DAEMON_VER,
                DAEMON_ID,
            ),
            computeProof(
                KEY,
                "subc-server-v1",
                CLIENT_NONCE,
                flip(SERVER_NONCE),
                DAEMON_VER,
                DAEMON_ID,
            ),
            computeProof(
                KEY,
                "subc-server-v1",
                CLIENT_NONCE,
                SERVER_NONCE,
                DAEMON_VER,
                flip(DAEMON_ID),
            ),
            computeProof(
                KEY,
                "subc-server-v1",
                CLIENT_NONCE,
                SERVER_NONCE,
                `${DAEMON_VER}-changed`,
                DAEMON_ID,
            ),
        ];
        for (const proof of perturbed) {
            expect(Array.from(proof)).not.toEqual(baseline);
        }
    });
});

describe("authenticateClient transcript", () => {
    test("happy path emits the literal ClientHello and ClientAuth", async () => {
        const io = new FakeIo(frameJson(serverProofMessage()));
        const result = await authenticateClient(
            io,
            { key: KEY, daemonId: DAEMON_ID, daemonVer: DAEMON_VER },
            farDeadline(),
            injectedNonce,
        );
        expect(result.daemonVer).toBe(DAEMON_VER);
        expect(io.writes.length).toBe(2);
        expect(decodeWrite(io.writes[0] as Uint8Array)).toEqual({
            client_nonce: Array.from(CLIENT_NONCE),
            role: "client",
        });
        expect(decodeWrite(io.writes[1] as Uint8Array)).toEqual({
            client_auth: Array.from(CLIENT_AUTH_LITERAL),
        });
    });

    test("accepts a ServerProof padded to exactly 4,096 bytes", async () => {
        const io = new FakeIo(frameJson(serverProofMessage(), 4_096));
        const result = await authenticateClient(
            io,
            { key: KEY, daemonId: DAEMON_ID, daemonVer: DAEMON_VER },
            farDeadline(),
            injectedNonce,
        );
        expect(result.daemonVer).toBe(DAEMON_VER);
        expect(io.writes.length).toBe(2);
    });

    test("rejects a 4,097-byte declaration before requesting the body", async () => {
        const prefix = new Uint8Array(4);
        new DataView(prefix.buffer).setUint32(0, 4_097, true);
        const io = new FakeIo(prefix);
        await expectAuthFailure(io, "message_too_large");
        expect(io.readRequests).toEqual([4]);
    });

    test("rejects wrong-length server fields without emitting ClientAuth", async () => {
        const wrongLength: Record<string, unknown>[] = [
            { daemon_id: Array.from(DAEMON_ID.subarray(0, 15)) },
            { daemon_id: [...Array.from(DAEMON_ID), 0] },
            { server_nonce: Array.from(SERVER_NONCE.subarray(0, 31)) },
            { server_proof: Array.from(SERVER_PROOF_LITERAL.subarray(0, 31)) },
            { server_proof: [...Array.from(SERVER_PROOF_LITERAL), 0] },
        ];
        for (const overrides of wrongLength) {
            const io = new FakeIo(frameJson(serverProofMessage(overrides)));
            await expectAuthFailure(io, "malformed_message");
        }
    });

    test("rejects non-integer, out-of-range, and null byte elements", async () => {
        const corrupt = (mutate: (bytes: number[]) => void): Record<string, unknown> => {
            const bytes = Array.from(SERVER_PROOF_LITERAL) as unknown[];
            mutate(bytes as number[]);
            return { server_proof: bytes };
        };
        const messages = [
            corrupt((bytes) => {
                bytes[0] = 1.5;
            }),
            corrupt((bytes) => {
                bytes[0] = -1;
            }),
            corrupt((bytes) => {
                bytes[0] = 256;
            }),
            corrupt((bytes) => {
                (bytes as unknown[])[0] = null;
            }),
        ];
        for (const overrides of messages) {
            const io = new FakeIo(frameJson(serverProofMessage(overrides)));
            await expectAuthFailure(io, "malformed_message");
        }
    });

    test("rejects an empty daemon_ver", async () => {
        const io = new FakeIo(frameJson(serverProofMessage({ daemon_ver: "" })));
        await expectAuthFailure(io, "malformed_message");
    });

    test("rejects a non-object ServerProof message", async () => {
        const io = new FakeIo(frameJson([1, 2, 3]));
        await expectAuthFailure(io, "malformed_message");
    });

    test("rejects invalid UTF-8 and invalid JSON bodies", async () => {
        const utf8Io = new FakeIo(frame(Uint8Array.from([0xff, 0xfe, 0xfd])));
        await expectAuthFailure(utf8Io, "malformed_message");
        const jsonIo = new FakeIo(frame(new TextEncoder().encode("{not json")));
        await expectAuthFailure(jsonIo, "malformed_message");
    });

    test("a proof mismatch produces no ClientAuth", async () => {
        const proof = Array.from(SERVER_PROOF_LITERAL);
        proof[0] = (proof[0] as number) ^ 0x01;
        const io = new FakeIo(frameJson(serverProofMessage({ server_proof: proof })));
        await expectAuthFailure(io, "proof_mismatch");
        expect(io.writes.length).toBe(1);
    });

    test("changing only daemon_ver invalidates the server proof", async () => {
        const io = new FakeIo(
            frameJson(serverProofMessage({ daemon_ver: `${DAEMON_VER}-mutated` })),
        );
        await expectAuthFailure(io, "proof_mismatch");
        expect(io.writes.length).toBe(1);
    });

    test("a daemon-id mismatch after a valid proof produces no ClientAuth", async () => {
        // The server proves knowledge of the key over a DIFFERENT daemon id:
        // the proof check passes, the identity check must still fail.
        const otherDaemonId = byteRange(0x70, 0x80);
        const proof = computeProof(
            KEY,
            "subc-server-v1",
            CLIENT_NONCE,
            SERVER_NONCE,
            DAEMON_VER,
            otherDaemonId,
        );
        const io = new FakeIo(
            frameJson(
                serverProofMessage({
                    daemon_id: Array.from(otherDaemonId),
                    server_proof: Array.from(proof),
                }),
            ),
        );
        await expectAuthFailure(io, "daemon_id_mismatch");
        expect(io.writes.length).toBe(1);
    });

    test("a daemon_ver mismatch after a valid proof produces no ClientAuth", async () => {
        const otherDaemonVer = "mc-host/999.0.0";
        const proof = computeProof(
            KEY,
            "subc-server-v1",
            CLIENT_NONCE,
            SERVER_NONCE,
            otherDaemonVer,
            DAEMON_ID,
        );
        const io = new FakeIo(
            frameJson(
                serverProofMessage({
                    daemon_ver: otherDaemonVer,
                    server_proof: Array.from(proof),
                }),
            ),
        );
        await expectAuthFailure(io, "daemon_ver_mismatch");
        expect(io.writes.length).toBe(1);
    });

    test("EOF during the length prefix or the body fails auth", async () => {
        const emptyIo = new FakeIo(new Uint8Array(0));
        await expectAuthFailure(emptyIo, "io_failure");
        expect(emptyIo.writes.length).toBe(1);

        const truncated = frameJson(serverProofMessage()).subarray(0, 20);
        const bodyIo = new FakeIo(truncated);
        await expectAuthFailure(bodyIo, "io_failure");
        expect(bodyIo.writes.length).toBe(1);
    });

    test("an already-expired deadline writes nothing at all", async () => {
        const { clock } = fakeClock();
        const io = new FakeIo(frameJson(serverProofMessage()));
        await expectAuthFailure(io, "deadline_expired", Deadline.start(0, clock));
        expect(io.writes.length).toBe(0);
    });

    test("deadline expiry mid-transcript produces no ClientAuth", async () => {
        const { clock, advance } = fakeClock();
        const deadline = Deadline.start(1_000, clock);
        // Every I/O step consumes 600ms: the ClientHello write succeeds, the
        // deadline is dead before the ServerProof read completes.
        const io = new FakeIo(frameJson(serverProofMessage()), () => advance(600));
        await expectAuthFailure(io, "deadline_expired", deadline);
        expect(io.writes.length).toBe(1);
    });

    test("rejects invalid local credential lengths before any write", async () => {
        const io = new FakeIo(frameJson(serverProofMessage()));
        const attempt = authenticateClient(
            io,
            { key: KEY.subarray(0, 31), daemonId: DAEMON_ID, daemonVer: DAEMON_VER },
            farDeadline(),
            injectedNonce,
        );
        await expect(attempt).rejects.toMatchObject({
            name: "AuthError",
            code: "invalid_credentials",
        });
        expect(io.writes.length).toBe(0);
    });

    test("uses a fresh random nonce per attempt by default", async () => {
        const first = new FakeIo(new Uint8Array(0));
        const second = new FakeIo(new Uint8Array(0));
        for (const io of [first, second]) {
            await authenticateClient(
                io,
                { key: KEY, daemonId: DAEMON_ID, daemonVer: DAEMON_VER },
                farDeadline(),
            ).catch(() => {});
        }
        const nonceOf = (io: FakeIo): number[] =>
            (decodeWrite(io.writes[0] as Uint8Array) as { client_nonce: number[] }).client_nonce;
        expect(nonceOf(first).length).toBe(32);
        expect(nonceOf(first)).not.toEqual(nonceOf(second));
    });
});
