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
export declare const PROTOCOL_VERSION = 2;
export declare const HEADER_LEN = 21;
/** Bytes 0..5 (`len` then `ver`) never change layout across versions. */
export declare const FROZEN_PREFIX_LEN = 5;
/** Interoperability body maximum: exactly 64 MiB (wire doc Section 6.3). */
export declare const MAX_FRAME_BODY_LEN = 67108864;
/** Largest correlation: one final request, then the generation must retire. */
export declare const MAX_CORRELATION = 18446744073709551615n;
/**
 * `type` byte at offset 5. Runtime const object plus union type (never a
 * TypeScript enum) so bundled Node/Bun loading needs no enum transform.
 */
export declare const FrameType: {
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
export type FrameType = (typeof FrameType)[keyof typeof FrameType];
/** `Cancel`/`Ping`/`Pong`/`Goodbye` carry only a header (`len` must be 0). */
export declare function isPureHeader(ty: FrameType): boolean;
/** Build a flags byte from typed components. Admission defaults to Normal. */
export declare function buildFlags(binary: boolean, priority: Priority, last: boolean, admissionClass?: AdmissionClass): number;
export declare function flagsBinary(flags: number): boolean;
export declare function flagsPriority(flags: number): Priority;
export declare function flagsLast(flags: number): boolean;
export declare function flagsAdmissionClass(flags: number): AdmissionClass;
export type DecodeErrorCode = "too_short_for_prefix" | "unsupported_version" | "too_short_for_header" | "unknown_frame_type" | "reserved_flag_bits" | "reserved_priority_bits" | "reserved_admission_class" | "sheddable_illegal_frame_type" | "nonzero_epoch_on_control_channel" | "zero_epoch_on_routed_channel" | "pure_header_frame_with_body" | "pure_header_frame_flags" | "frame_body_too_large" | "role_or_identity_violation";
/** Typed envelope decode/encode failure mirroring the wire taxonomy. */
export declare class DecodeError extends Error {
    readonly code: DecodeErrorCode;
    constructor(message: string, code: DecodeErrorCode);
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
/**
 * Validate one complete header against the structural rules of wire doc
 * Sections 6.1-6.3. Shared by encode and decode so both sides reject the
 * same shapes; throws `DecodeError` on the first violation.
 */
export declare function validateHeader(header: EnvelopeHeader): void;
/**
 * Serialize a header to its fixed 21-byte little-endian form after full
 * range and structural validation.
 */
export declare function encodeHeader(header: EnvelopeHeader): Uint8Array;
/**
 * Decode and fully validate a header from the front of `bytes`. Follows the
 * frozen-prefix order: read `len`+`ver`, reject an unsupported version, read
 * the remaining header bytes, then validate the complete header before the
 * caller allocates or reads any body byte.
 */
export declare function decodeHeader(bytes: Uint8Array): EnvelopeHeader;
/**
 * Frame types a consumer may legally receive from the host (wire doc Section
 * 6.2). `Hello`/`HelloAck` stay numerically decodable but are role-invalid
 * on a consumer connection; a host-originated `Request` is role-invalid too.
 * Receiving any role-invalid type must close the generation.
 */
export declare function isLegalHostToConsumerType(ty: FrameType): boolean;
/** Frame types a consumer may legally originate (wire doc Section 6.2). */
export declare function isLegalConsumerToHostType(ty: FrameType): boolean;
/**
 * The sender's correlation namespace a received frame settles (wire doc
 * Section 8.3): each direction allocates correlations independently, so a
 * numerically equal host `Ping` correlation never collides with a pending
 * consumer request. Returns `undefined` for frame types that settle nothing.
 */
export declare function settledCorrelationNamespace(ty: FrameType): "consumer" | "host" | undefined;
//# sourceMappingURL=protocol.d.ts.map