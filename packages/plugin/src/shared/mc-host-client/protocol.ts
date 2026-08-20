/**
 * Independent v2 envelope codec for the mc-host direct profile.
 *
 * Normative authority: `docs/mc-host-wire-protocol.md` Section 6 (21-byte
 * little-endian header, frame types, flags bit layout, pure-header rules,
 * exact 64 MiB body cap) and Sections 6.2/8.3 (direction and correlation
 * namespaces). Leaf module: no imports from connection or facade code and no
 * npm subc-client code.
 */

import { AdmissionClass, type Priority } from "./types";

export const PROTOCOL_VERSION = 2;
export const HEADER_LEN = 21;
/** Bytes 0..5 (`len` then `ver`) never change layout across versions. */
export const FROZEN_PREFIX_LEN = 5;
/** Interoperability body maximum: exactly 64 MiB (wire doc Section 6.3). */
export const MAX_FRAME_BODY_LEN = 67_108_864;
/** Largest correlation: one final request, then the generation must retire. */
export const MAX_CORRELATION = 0xffff_ffff_ffff_ffffn;

/**
 * `type` byte at offset 5. Runtime const object plus union type (never a
 * TypeScript enum) so bundled Node/Bun loading needs no enum transform.
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

/** Build a flags byte from typed components. Admission defaults to Normal. */
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

/** Typed envelope decode/encode failure mirroring the wire taxonomy. */
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
    /** u64 correlation; bigint so `2^64 - 1` is representable exactly. */
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
 * Validate one complete header against the structural rules of wire doc
 * Sections 6.1-6.3. Shared by encode and decode so both sides reject the
 * same shapes; throws `DecodeError` on the first violation.
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
 * Serialize a header to its fixed 21-byte little-endian form after full
 * range and structural validation.
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
 * Decode and fully validate a header from the front of `bytes`. Follows the
 * frozen-prefix order: read `len`+`ver`, reject an unsupported version, read
 * the remaining header bytes, then validate the complete header before the
 * caller allocates or reads any body byte.
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
 * Frame types a consumer may legally receive from the host (wire doc Section
 * 6.2). `Hello`/`HelloAck` stay numerically decodable but are role-invalid
 * on a consumer connection; a host-originated `Request` is role-invalid too.
 * Receiving any role-invalid type must close the generation.
 */
export function isLegalHostToConsumerType(ty: FrameType): boolean {
    return HOST_TO_CONSUMER_TYPES.has(ty);
}

/** Frame types a consumer may legally originate (wire doc Section 6.2). */
export function isLegalConsumerToHostType(ty: FrameType): boolean {
    return CONSUMER_TO_HOST_TYPES.has(ty);
}

/**
 * The sender's correlation namespace a received frame settles (wire doc
 * Section 8.3): each direction allocates correlations independently, so a
 * numerically equal host `Ping` correlation never collides with a pending
 * consumer request. Returns `undefined` for frame types that settle nothing.
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
