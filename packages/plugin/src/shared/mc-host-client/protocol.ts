/**
 *
 * `docs/mc-host-wire-protocol.md` is normative for this codec.
 * Section 6 defines the 21-byte little-endian header, frame types, flags layout, pure-header rules, and 64 MiB body cap.
 * Sections 6.2 and 8.3 define direction and correlation namespaces.
 */

import { AdmissionClass, type Priority } from "./types";

export const PROTOCOL_VERSION = 2;
export const HEADER_LEN = 21;
/** Bytes 0..4 (`len` then `ver`) never change layout across versions. */
export const FROZEN_PREFIX_LEN = 5;
/** The protocol caps frame bodies at 64 MiB. */
export const MAX_FRAME_BODY_LEN = 67_108_864;
/** A generation must retire after issuing a request with `MAX_CORRELATION`. */
export const MAX_CORRELATION = 0xffff_ffff_ffff_ffffn;

/**
 * The `type` byte occupies offset 5.
 */
export const FrameType = {
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
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const FRAME_TYPE_MAX = FrameType.Goodbye;

const FRAME_TYPE_NAMES = [
    "Request",
    "Response",
    "Push",
    "StreamData",
    "StreamEnd",
    "Error",
    "Cancel",
    "Ping",
    "Pong",
    "Hello",
    "HelloAck",
    "Goodbye",
] as const;

/** `Cancel`/`Ping`/`Pong`/`Goodbye` carry only a header (`len` must be 0). */
export function isPureHeader(ty: FrameType): boolean {
    return (
        ty === FrameType.Cancel ||
        ty === FrameType.Ping ||
        ty === FrameType.Pong ||
        ty === FrameType.Goodbye
    );
}

const FLAG_BINARY = 0b0000_0001;
const FLAG_PRIORITY_MASK = 0b0000_0110;
const FLAG_PRIORITY_SHIFT = 1;
const FLAG_LAST = 0b0000_1000;
const FLAG_ADMISSION_MASK = 0b0011_0000;
const FLAG_ADMISSION_SHIFT = 4;
const FLAG_RESERVED_MASK = 0b1100_0000;

/* */
export function buildFlags(
    binary: boolean,
    priority: Priority,
    last: boolean,
    admissionClass: AdmissionClass = AdmissionClass.Normal,
): number {
    let flags = 0;
    if (binary) flags |= FLAG_BINARY;
    flags |= priority << FLAG_PRIORITY_SHIFT;
    if (last) flags |= FLAG_LAST;
    flags |= admissionClass << FLAG_ADMISSION_SHIFT;
    return flags;
}

export function flagsBinary(flags: number): boolean {
    return (flags & FLAG_BINARY) !== 0;
}

export function flagsPriority(flags: number): Priority {
    return ((flags & FLAG_PRIORITY_MASK) >> FLAG_PRIORITY_SHIFT) as Priority;
}

export function flagsLast(flags: number): boolean {
    return (flags & FLAG_LAST) !== 0;
}

export function flagsAdmissionClass(flags: number): AdmissionClass {
    return ((flags & FLAG_ADMISSION_MASK) >> FLAG_ADMISSION_SHIFT) as AdmissionClass;
}

export type DecodeErrorCode =
    | "too_short_for_prefix"
    | "unsupported_version"
    | "too_short_for_header"
    | "unknown_frame_type"
    | "reserved_flag_bits"
    | "reserved_priority_bits"
    | "reserved_admission_class"
    | "sheddable_illegal_frame_type"
    | "nonzero_epoch_on_control_channel"
    | "zero_epoch_on_routed_channel"
    | "pure_header_frame_with_body"
    | "pure_header_frame_flags"
    | "frame_body_too_large"
    | "role_or_identity_violation";

/* */
export class DecodeError extends Error {
    constructor(
        message: string,
        readonly code: DecodeErrorCode,
    ) {
        super(message);
        this.name = "DecodeError";
    }
}

export interface EnvelopeHeader {
    len: number;
    ver: number;
    ty: FrameType;
    flags: number;
    channel: number;
    epoch: number;
    /** `corr` uses `bigint` so `2^64 - 1` is representable exactly. */
    corr: bigint;
}

function flagsBits(flags: number): string {
    return `0b${flags.toString(2).padStart(8, "0")}`;
}

function requireUint(value: number, max: number, field: string): void {
    if (!Number.isInteger(value) || value < 0 || value > max) {
        throw new RangeError(`${field} must be an integer in 0..${max}, got ${value}`);
    }
}

/**
 * Encoding and decoding share structural validation and reject the same header shapes.
 * The decoder throws `DecodeError` for the first invalid header field.
 */
export function validateHeader(header: EnvelopeHeader): void {
    if (header.ver !== PROTOCOL_VERSION) {
        throw new DecodeError(`unsupported envelope version ${header.ver}`, "unsupported_version");
    }
    if (!Number.isInteger(header.ty) || header.ty < 0 || header.ty > FRAME_TYPE_MAX) {
        throw new DecodeError(`unknown frame type byte ${header.ty}`, "unknown_frame_type");
    }
    if (header.len > MAX_FRAME_BODY_LEN) {
        throw new DecodeError(
            `frame body length ${header.len} exceeds max ${MAX_FRAME_BODY_LEN}`,
            "frame_body_too_large",
        );
    }
    const flags = header.flags;
    if ((flags & FLAG_RESERVED_MASK) !== 0) {
        throw new DecodeError(
            `reserved flag bits set in flags ${flagsBits(flags)}`,
            "reserved_flag_bits",
        );
    }
    if ((flags & FLAG_PRIORITY_MASK) >> FLAG_PRIORITY_SHIFT === 0b11) {
        throw new DecodeError(
            `reserved priority bits set in flags ${flagsBits(flags)}`,
            "reserved_priority_bits",
        );
    }
    const admission = (flags & FLAG_ADMISSION_MASK) >> FLAG_ADMISSION_SHIFT;
    if (admission === 0b11) {
        throw new DecodeError(
            `reserved admission class set in flags ${flagsBits(flags)}`,
            "reserved_admission_class",
        );
    }
    const name = FRAME_TYPE_NAMES[header.ty];
    if (
        admission === AdmissionClass.Sheddable &&
        header.ty !== FrameType.Push &&
        header.ty !== FrameType.StreamData
    ) {
        throw new DecodeError(
            `Sheddable admission class is illegal on ${name} in flags ${flagsBits(flags)}`,
            "sheddable_illegal_frame_type",
        );
    }
    if (header.channel === 0 && header.epoch !== 0) {
        throw new DecodeError(
            `control channel carried nonzero epoch ${header.epoch}`,
            "nonzero_epoch_on_control_channel",
        );
    }
    if (header.channel !== 0 && header.epoch === 0) {
        throw new DecodeError(
            `routed channel ${header.channel} carried zero epoch`,
            "zero_epoch_on_routed_channel",
        );
    }
    if (isPureHeader(header.ty)) {
        if (header.len !== 0) {
            throw new DecodeError(
                `pure-header frame ${name} declared non-zero body length ${header.len}`,
                "pure_header_frame_with_body",
            );
        }
        if (flagsBinary(flags) || flagsLast(flags) || admission !== AdmissionClass.Normal) {
            throw new DecodeError(
                `pure-header frame ${name} requires binary=0, last=0, admission Normal; got flags ${flagsBits(flags)}`,
                "pure_header_frame_flags",
            );
        }
    }
}

/**
 * Encoding validates all ranges and structural rules before serialization.
 */
export function encodeHeader(header: EnvelopeHeader): Uint8Array {
    requireUint(header.len, 0xffff_ffff, "header len");
    requireUint(header.ver, 0xff, "header ver");
    requireUint(header.ty, 0xff, "header type");
    requireUint(header.flags, 0xff, "header flags");
    requireUint(header.channel, 0xffff, "header channel");
    requireUint(header.epoch, 0xffff_ffff, "header epoch");
    if (header.corr < 0n || header.corr > MAX_CORRELATION) {
        throw new RangeError(`header corr must be a u64, got ${header.corr}`);
    }
    validateHeader(header);
    const buffer = new Uint8Array(HEADER_LEN);
    const view = new DataView(buffer.buffer);
    view.setUint32(0, header.len, true);
    buffer[4] = header.ver;
    buffer[5] = header.ty;
    buffer[6] = header.flags;
    view.setUint16(7, header.channel, true);
    view.setUint32(9, header.epoch, true);
    view.setBigUint64(13, header.corr, true);
    return buffer;
}

/**
 * The decoder validates the complete header before returning it.
 * The decoder reads `len` and `ver` before rejecting unsupported versions.
 * The decoder reads the remaining header bytes only after accepting the version.
 * The decoder validates the complete header before reading body bytes.
 */
export function decodeHeader(bytes: Uint8Array): EnvelopeHeader {
    if (bytes.length < FROZEN_PREFIX_LEN) {
        throw new DecodeError(
            `header shorter than frozen prefix: have ${bytes.length} bytes`,
            "too_short_for_prefix",
        );
    }
    const ver = bytes[4] as number;
    if (ver !== PROTOCOL_VERSION) {
        throw new DecodeError(`unsupported envelope version ${ver}`, "unsupported_version");
    }
    if (bytes.length < HEADER_LEN) {
        throw new DecodeError(
            `header too short for version: have ${bytes.length} bytes, need ${HEADER_LEN}`,
            "too_short_for_header",
        );
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header: EnvelopeHeader = {
        len: view.getUint32(0, true),
        ver,
        ty: bytes[5] as number as FrameType,
        flags: bytes[6] as number,
        channel: view.getUint16(7, true),
        epoch: view.getUint32(9, true),
        corr: view.getBigUint64(13, true),
    };
    validateHeader(header);
    return header;
}

const HOST_TO_CONSUMER_TYPES: ReadonlySet<FrameType> = new Set<FrameType>([
    FrameType.Response,
    FrameType.Error,
    FrameType.StreamData,
    FrameType.StreamEnd,
    FrameType.Ping,
    FrameType.Push,
    FrameType.Goodbye,
]);

const CONSUMER_TO_HOST_TYPES: ReadonlySet<FrameType> = new Set<FrameType>([
    FrameType.Request,
    FrameType.Cancel,
    FrameType.Pong,
    FrameType.Goodbye,
]);

/**
 * On consumer connections, `Hello` and `HelloAck` are numerically decodable but role-invalid.
 * A host-originated `Request` is role-invalid on consumer connections.
 * Receiving any role-invalid type must close the generation.
 */
export function isLegalHostToConsumerType(ty: FrameType): boolean {
    return HOST_TO_CONSUMER_TYPES.has(ty);
}

/* */
export function isLegalConsumerToHostType(ty: FrameType): boolean {
    return CONSUMER_TO_HOST_TYPES.has(ty);
}

/**
 * A received frame settles the sender's correlation namespace.
 * Each direction allocates correlations independently.
 */
export function settledCorrelationNamespace(ty: FrameType): "consumer" | "host" | undefined {
    switch (ty) {
        case FrameType.Response:
        case FrameType.Error:
        case FrameType.StreamData:
        case FrameType.StreamEnd:
            return "consumer";
        case FrameType.Pong:
            return "host";
        default:
            return undefined;
    }
}
