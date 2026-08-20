import { describe, expect, test } from "bun:test";
import {
    buildFlags,
    DecodeError,
    type DecodeErrorCode,
    decodeHeader,
    type EnvelopeHeader,
    encodeHeader,
    FROZEN_PREFIX_LEN,
    FrameType,
    flagsAdmissionClass,
    flagsBinary,
    flagsLast,
    flagsPriority,
    HEADER_LEN,
    isLegalConsumerToHostType,
    isLegalHostToConsumerType,
    isPureHeader,
    MAX_CORRELATION,
    MAX_FRAME_BODY_LEN,
    PROTOCOL_VERSION,
    settledCorrelationNamespace,
} from "./protocol";
import {
    assertBelongsToConnection,
    belongsToConnection,
    createRouteHandle,
    newConnectionToken,
    RouteHandle,
    StaleRouteHandleError,
} from "./route-handle";
import { AdmissionClass, Priority } from "./types";

const ROUTE_OPEN_HEADER_HEX = "ad0000000200020000000000000100000000000000";
const ROUTED_REQUEST_HEADER_HEX = "2c00000002000407004d0000000200000000000000";

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeHex(hex: string): EnvelopeHeader {
    return decodeHeader(hexToBytes(hex));
}

function expectDecodeError(bytes: Uint8Array, code: DecodeErrorCode): void {
    let caught: unknown;
    try {
        decodeHeader(bytes);
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(DecodeError);
    expect((caught as DecodeError).code).toBe(code);
}

/** A valid 21-byte routed StreamData header for mutation-based rejection tests. */
function validHeaderBytes(): Uint8Array {
    return hexToBytes(
        bytesToHex(
            encodeHeader({
                len: 0,
                ver: PROTOCOL_VERSION,
                ty: FrameType.StreamData,
                flags: 0,
                channel: 7,
                epoch: 77,
                corr: 5n,
            }),
        ),
    );
}

describe("committed wire-doc Section 6.4 vectors", () => {
    test("decodes the canonical route.open request header field-by-field", () => {
        const header = decodeHex(ROUTE_OPEN_HEADER_HEX);
        expect(header.len).toBe(173);
        expect(header.ver).toBe(2);
        expect(header.ty).toBe(FrameType.Request);
        expect(flagsBinary(header.flags)).toBe(false);
        expect(flagsPriority(header.flags)).toBe(Priority.Interactive);
        expect(flagsLast(header.flags)).toBe(false);
        expect(flagsAdmissionClass(header.flags)).toBe(AdmissionClass.Normal);
        expect(header.channel).toBe(0);
        expect(header.epoch).toBe(0);
        expect(header.corr).toBe(1n);
    });

    test("encodes the canonical route.open request header to the exact bytes", () => {
        const bytes = encodeHeader({
            len: 173,
            ver: PROTOCOL_VERSION,
            ty: FrameType.Request,
            flags: buildFlags(false, Priority.Interactive, false),
            channel: 0,
            epoch: 0,
            corr: 1n,
        });
        expect(bytesToHex(bytes)).toBe(ROUTE_OPEN_HEADER_HEX);
    });

    test("decodes the routed Background request header field-by-field", () => {
        const header = decodeHex(ROUTED_REQUEST_HEADER_HEX);
        expect(header.len).toBe(44);
        expect(header.ver).toBe(2);
        expect(header.ty).toBe(FrameType.Request);
        expect(flagsBinary(header.flags)).toBe(false);
        expect(flagsPriority(header.flags)).toBe(Priority.Background);
        expect(flagsLast(header.flags)).toBe(false);
        expect(flagsAdmissionClass(header.flags)).toBe(AdmissionClass.Normal);
        expect(header.channel).toBe(7);
        expect(header.epoch).toBe(77);
        expect(header.corr).toBe(2n);
    });

    test("encodes the routed Background request header to the exact bytes", () => {
        const bytes = encodeHeader({
            len: 44,
            ver: PROTOCOL_VERSION,
            ty: FrameType.Request,
            flags: buildFlags(false, Priority.Background, false),
            channel: 7,
            epoch: 77,
            corr: 2n,
        });
        expect(bytesToHex(bytes)).toBe(ROUTED_REQUEST_HEADER_HEX);
    });
});

describe("header round trips", () => {
    test("minimum legal field values", () => {
        const header: EnvelopeHeader = {
            len: 0,
            ver: PROTOCOL_VERSION,
            ty: FrameType.Request,
            flags: buildFlags(false, Priority.Passive, false),
            channel: 0,
            epoch: 0,
            corr: 0n,
        };
        const bytes = encodeHeader(header);
        expect(bytes.length).toBe(HEADER_LEN);
        expect(decodeHeader(bytes)).toEqual(header);
    });

    test("maximum legal field values including correlation u64::MAX", () => {
        const header: EnvelopeHeader = {
            len: MAX_FRAME_BODY_LEN,
            ver: PROTOCOL_VERSION,
            ty: FrameType.StreamData,
            flags: buildFlags(true, Priority.Background, true, AdmissionClass.Sheddable),
            channel: 0xffff,
            epoch: 0xffff_ffff,
            corr: MAX_CORRELATION,
        };
        const decoded = decodeHeader(encodeHeader(header));
        expect(decoded).toEqual(header);
        expect(decoded.corr).toBe(0xffff_ffff_ffff_ffffn);
    });

    test("decodes from a nonzero byte offset within a larger buffer", () => {
        const padded = new Uint8Array(7 + HEADER_LEN);
        padded.set(hexToBytes(ROUTED_REQUEST_HEADER_HEX), 7);
        const header = decodeHeader(padded.subarray(7));
        expect(header.channel).toBe(7);
        expect(header.epoch).toBe(77);
        expect(header.corr).toBe(2n);
    });
});

describe("structural rejections before body handling", () => {
    test("rejects a declared body of 64 MiB + 1 while accepting exactly 64 MiB", () => {
        const bytes = validHeaderBytes();
        const view = new DataView(bytes.buffer);
        view.setUint32(0, MAX_FRAME_BODY_LEN, true);
        expect(decodeHeader(bytes).len).toBe(67_108_864);
        view.setUint32(0, MAX_FRAME_BODY_LEN + 1, true);
        expectDecodeError(bytes, "frame_body_too_large");
    });

    test("rejects unsupported versions from the frozen prefix", () => {
        for (const ver of [0, 1, 3, 255]) {
            const bytes = validHeaderBytes();
            bytes[4] = ver;
            expectDecodeError(bytes, "unsupported_version");
        }
    });

    test("rejects truncated prefix and truncated header", () => {
        const bytes = validHeaderBytes();
        expectDecodeError(bytes.subarray(0, FROZEN_PREFIX_LEN - 1), "too_short_for_prefix");
        expectDecodeError(bytes.subarray(0, HEADER_LEN - 1), "too_short_for_header");
    });

    test("rejects unknown frame type bytes", () => {
        for (const ty of [12, 13, 255]) {
            const bytes = validHeaderBytes();
            bytes[5] = ty;
            expectDecodeError(bytes, "unknown_frame_type");
        }
    });

    test("rejects invalid priority bits (value 3)", () => {
        const bytes = validHeaderBytes();
        bytes[6] = 0b0000_0110;
        expectDecodeError(bytes, "reserved_priority_bits");
    });

    test("rejects invalid admission class bits (value 3)", () => {
        const bytes = validHeaderBytes();
        bytes[6] = 0b0011_0000;
        expectDecodeError(bytes, "reserved_admission_class");
    });

    test("rejects nonzero reserved bits 6-7", () => {
        for (const reserved of [0b0100_0000, 0b1000_0000, 0b1100_0000]) {
            const bytes = validHeaderBytes();
            bytes[6] = reserved;
            expectDecodeError(bytes, "reserved_flag_bits");
        }
    });

    test("Sheddable admission is legal only on Push and StreamData", () => {
        const sheddable = buildFlags(false, Priority.Passive, false, AdmissionClass.Sheddable);
        for (const ty of [FrameType.Push, FrameType.StreamData]) {
            const bytes = validHeaderBytes();
            bytes[5] = ty;
            bytes[6] = sheddable;
            expect(decodeHeader(bytes).ty).toBe(ty);
        }
        for (const ty of [
            FrameType.Request,
            FrameType.Response,
            FrameType.StreamEnd,
            FrameType.Error,
        ]) {
            const bytes = validHeaderBytes();
            bytes[5] = ty;
            bytes[6] = sheddable;
            expectDecodeError(bytes, "sheddable_illegal_frame_type");
        }
    });

    test("rejects a nonzero epoch on the control channel", () => {
        const bytes = validHeaderBytes();
        const view = new DataView(bytes.buffer);
        view.setUint16(7, 0, true);
        expectDecodeError(bytes, "nonzero_epoch_on_control_channel");
    });

    test("rejects a zero epoch on a routed channel", () => {
        const bytes = validHeaderBytes();
        const view = new DataView(bytes.buffer);
        view.setUint32(9, 0, true);
        expectDecodeError(bytes, "zero_epoch_on_routed_channel");
    });

    test("rejects a declared body on every pure-header frame type", () => {
        for (const ty of [FrameType.Cancel, FrameType.Ping, FrameType.Pong, FrameType.Goodbye]) {
            expect(isPureHeader(ty)).toBe(true);
            const bytes = validHeaderBytes();
            const view = new DataView(bytes.buffer);
            bytes[5] = ty;
            bytes[6] = 0;
            view.setUint32(0, 1, true);
            expectDecodeError(bytes, "pure_header_frame_with_body");
        }
    });

    test("pure-header frames require binary=0, last=0, admission Normal; any priority is fine", () => {
        const illegal = [
            buildFlags(true, Priority.Passive, false),
            buildFlags(false, Priority.Passive, true),
            buildFlags(false, Priority.Passive, false, AdmissionClass.Expedite),
        ];
        for (const flags of illegal) {
            const bytes = validHeaderBytes();
            bytes[5] = FrameType.Ping;
            bytes[6] = flags;
            expectDecodeError(bytes, "pure_header_frame_flags");
        }
        const bytes = validHeaderBytes();
        bytes[5] = FrameType.Ping;
        bytes[6] = buildFlags(false, Priority.Interactive, false);
        expect(decodeHeader(bytes).ty).toBe(FrameType.Ping);
    });
});

describe("encode-side field validation", () => {
    function header(overrides: Partial<EnvelopeHeader>): EnvelopeHeader {
        return {
            len: 0,
            ver: PROTOCOL_VERSION,
            ty: FrameType.Request,
            flags: 0,
            channel: 0,
            epoch: 0,
            corr: 1n,
            ...overrides,
        };
    }

    test("rejects out-of-range or non-integer numeric fields", () => {
        expect(() => encodeHeader(header({ channel: 0x1_0000 }))).toThrow(RangeError);
        expect(() => encodeHeader(header({ channel: -1 }))).toThrow(RangeError);
        expect(() => encodeHeader(header({ channel: 1.5 }))).toThrow(RangeError);
        expect(() => encodeHeader(header({ epoch: 0x1_0000_0000 }))).toThrow(RangeError);
        expect(() => encodeHeader(header({ len: -1 }))).toThrow(RangeError);
    });

    test("rejects correlations outside u64", () => {
        expect(() => encodeHeader(header({ corr: -1n }))).toThrow(RangeError);
        expect(() => encodeHeader(header({ corr: MAX_CORRELATION + 1n }))).toThrow(RangeError);
    });

    test("rejects structurally illegal headers with the shared decode taxonomy", () => {
        expect(() => encodeHeader(header({ ver: 1 }))).toThrow(DecodeError);
        expect(() => encodeHeader(header({ ty: FrameType.Ping, len: 4 }))).toThrow(DecodeError);
        expect(() => encodeHeader(header({ channel: 7, epoch: 0 }))).toThrow(DecodeError);
    });
});

describe("frame build and encode", () => {
    test("encodeHeader + body emits header then exactly len body bytes", () => {
        const body = new TextEncoder().encode('{"op":"catalog.list"}');
        const frameHeader: EnvelopeHeader = {
            len: body.length,
            ver: PROTOCOL_VERSION,
            ty: FrameType.Request,
            flags: buildFlags(false, Priority.Interactive, false),
            channel: 0,
            epoch: 0,
            corr: 3n,
        };
        const bytes = Buffer.concat([encodeHeader(frameHeader), body]);
        expect(bytes.length).toBe(HEADER_LEN + body.length);
        expect(decodeHeader(bytes)).toEqual(frameHeader);
        expect(bytes.subarray(HEADER_LEN)).toEqual(Buffer.from(body));
    });
});

describe("direction legality", () => {
    test("accepts exactly the host-to-consumer frame types", () => {
        const legal = new Set<FrameType>([
            FrameType.Response,
            FrameType.Error,
            FrameType.StreamData,
            FrameType.StreamEnd,
            FrameType.Ping,
            FrameType.Push,
            FrameType.Goodbye,
        ]);
        for (const ty of Object.values(FrameType)) {
            expect(isLegalHostToConsumerType(ty)).toBe(legal.has(ty));
        }
    });

    test("accepts exactly the consumer-originated frame types", () => {
        const legal = new Set<FrameType>([
            FrameType.Request,
            FrameType.Cancel,
            FrameType.Pong,
            FrameType.Goodbye,
        ]);
        for (const ty of Object.values(FrameType)) {
            expect(isLegalConsumerToHostType(ty)).toBe(legal.has(ty));
        }
    });

    test("Hello and HelloAck stay numerically decodable yet role-invalid from the host", () => {
        for (const ty of [FrameType.Hello, FrameType.HelloAck]) {
            const bytes = validHeaderBytes();
            const view = new DataView(bytes.buffer);
            bytes[5] = ty;
            view.setUint16(7, 0, true);
            view.setUint32(9, 0, true);
            expect(decodeHeader(bytes).ty).toBe(ty);
            expect(isLegalHostToConsumerType(ty)).toBe(false);
            expect(isLegalConsumerToHostType(ty)).toBe(false);
        }
    });

    test("correlation settlement is direction-scoped", () => {
        expect(settledCorrelationNamespace(FrameType.Response)).toBe("consumer");
        expect(settledCorrelationNamespace(FrameType.Error)).toBe("consumer");
        expect(settledCorrelationNamespace(FrameType.StreamData)).toBe("consumer");
        expect(settledCorrelationNamespace(FrameType.StreamEnd)).toBe("consumer");
        expect(settledCorrelationNamespace(FrameType.Pong)).toBe("host");
        expect(settledCorrelationNamespace(FrameType.Ping)).toBeUndefined();
        expect(settledCorrelationNamespace(FrameType.Request)).toBeUndefined();
        expect(settledCorrelationNamespace(FrameType.Goodbye)).toBeUndefined();
    });
});

describe("route handles", () => {
    test("binds a handle to its connection token", () => {
        const token = newConnectionToken();
        const handle = createRouteHandle(7, 77, token);
        expect(handle.channel).toBe(7);
        expect(handle.epoch).toBe(77);
        expect(Object.isFrozen(handle)).toBe(true);
        expect(belongsToConnection(handle, token)).toBe(true);
        expect(() => assertBelongsToConnection(handle, token)).not.toThrow();
    });

    test("rejects a handle from an older connection with the exact compatibility shape", () => {
        const oldToken = newConnectionToken();
        const newToken = newConnectionToken();
        const handle = createRouteHandle(7, 77, oldToken);
        expect(belongsToConnection(handle, newToken)).toBe(false);

        let caught: unknown;
        try {
            assertBelongsToConnection(handle, newToken);
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(StaleRouteHandleError);
        const stale = caught as StaleRouteHandleError;
        expect(stale.name).toBe("StaleRouteHandleError");
        expect(stale.code).toBe("stale_route_handle");
        expect(stale.message).toBe("route handle (7, 77) is not live on the current connection");
        expect(stale.handle).toBe(handle);
    });

    test("a directly constructed handle belongs to no connection", () => {
        const handle = new RouteHandle(7, 77);
        expect(belongsToConnection(handle, newConnectionToken())).toBe(false);
        expect(() => assertBelongsToConnection(handle, newConnectionToken())).toThrow(
            StaleRouteHandleError,
        );
    });

    test("rejects zero and out-of-range channels and epochs", () => {
        const token = newConnectionToken();
        expect(() => createRouteHandle(0, 1, token)).toThrow(RangeError);
        expect(() => createRouteHandle(0x1_0000, 1, token)).toThrow(RangeError);
        expect(() => createRouteHandle(1, 0, token)).toThrow(RangeError);
        expect(() => createRouteHandle(1, 0x1_0000_0000, token)).toThrow(RangeError);
        expect(() => createRouteHandle(1.5, 1, token)).toThrow(RangeError);
    });
});
