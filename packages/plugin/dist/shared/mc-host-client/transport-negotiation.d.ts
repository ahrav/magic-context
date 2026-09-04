/**
 * Negotiation version 1 wire grammar for the mc-host direct profile:
 * `transport.negotiate` offers and selections plus the candidate-only
 * `transport.activate` and `transport.commit` exchanges (wire doc Section
 * 7.7).
 *
 * Leaf module: no imports from connection or facade code. Decoding is
 * strict — closed field sets, exact bounds, and a duplicate-aware JSON
 * parse that rejects repeated object keys at every depth (including inside
 * the opaque provider `parameters` and `descriptor` values) before any
 * typed or opaque value is materialized. Decode failures carry only a
 * bounded code and a structural field path; provider bytes, tokens, and
 * descriptors never reach error messages.
 */
/** The negotiation grammar version this module implements. */
export declare const NEGOTIATION_VERSION = 1;
/** The required fallback transport name (wire doc Section 7.7.2). */
export declare const TRANSPORT_TCP = "tcp";
/** Offers are ordered by client preference, 1 to 8 entries. */
export declare const MAX_OFFERS = 8;
/** Transport names are 1-32 ASCII bytes matching `^[a-z][a-z0-9._-]{0,31}$`. */
export declare const MAX_TRANSPORT_NAME_BYTES = 32;
/** Opaque `parameters`/`descriptor` compact-JSON sub-cap in bytes. */
export declare const MAX_OPAQUE_BYTES = 8192;
/** Opaque `parameters`/`descriptor` nesting bound (Section 7.1 counting). */
export declare const MAX_OPAQUE_DEPTH = 8;
/** Activation tokens are exactly 32 lowercase hexadecimal characters. */
export declare const ACTIVATION_TOKEN_LEN = 32;
/** Candidate consumer correlation reserved for `transport.activate`. */
export declare const ACTIVATION_CORRELATION = 1n;
/** Candidate consumer correlation reserved for `transport.commit`. */
export declare const COMMIT_CORRELATION = 2n;
/** First candidate consumer correlation available to application requests. */
export declare const FIRST_APPLICATION_CORRELATION = 3n;
/** Bounded decode/encode failure taxonomy, mirrored by the Rust host. */
export type NegotiationErrorCode = "malformed_json" | "invalid_type" | "missing_field" | "unexpected_field" | "invalid_version" | "invalid_transport_name" | "invalid_offer_count" | "duplicate_offer" | "missing_tcp_offer" | "opaque_too_large" | "opaque_too_deep" | "invalid_activation_token" | "invalid_reason" | "unoffered_selection" | "wrong_operation";
/**
 * One negotiation decode/encode failure: a bounded code plus a structural
 * field path built only from documented field names and offer indices.
 * Client- or host-supplied bytes — unknown key names, provider parameters,
 * descriptors, and tokens — never appear here.
 */
export declare class NegotiationError extends Error {
    readonly code: NegotiationErrorCode;
    readonly path: string;
    constructor(code: NegotiationErrorCode, path: string);
}
/**
 * Closed fallback vocabulary (wire doc Section 7.7.3).
 *
 * Only these two reasons are fallback evidence. Every other setup outcome —
 * negotiation-version mismatch, `unsupported_operation`, `connection_in_use`,
 * timeout, malformed content, an unoffered selection — must fail closed with no
 * same-generation TCP continuation, so accepting one here would commit the
 * generation to TCP on evidence the protocol rejects.
 */
export declare const FALLBACK_REASONS: readonly ["unavailable", "capability_version_mismatch"];
export type FallbackReason = (typeof FALLBACK_REASONS)[number];
/** Opaque provider data: a bounded JSON object the core never interprets. */
export type OpaqueObject = Record<string, unknown>;
/** One ordered client offer. */
export interface TransportOffer {
    transport: string;
    capabilityVersion: number;
    parameters?: OpaqueObject;
}
/** The validated `transport.negotiate` request. */
export interface NegotiateRequest {
    negotiationVersion: number;
    offers: TransportOffer[];
}
/** The exact offered entry a response names. */
interface SelectedTransport {
    transport: string;
    capabilityVersion: number;
}
/**
 * The validated `transport.negotiate` response. The tagged union encodes the
 * field mix invariants: only a TCP selection may carry a `reason`, and only
 * a non-TCP grant carries the token/descriptor pair.
 */
export type NegotiateResponse = {
    kind: "tcp";
    selected: SelectedTransport;
    reason?: FallbackReason;
} | {
    kind: "grant";
    selected: SelectedTransport;
    activationToken: string;
    descriptor: OpaqueObject;
};
/** The validated candidate `transport.activate` request (correlation 1). */
export interface ActivateRequest {
    activationToken: string;
}
type JsonInput = Uint8Array | string;
/**
 * Decodes and fully validates one `transport.negotiate` request body. The
 * duplicate-aware parse runs first, so repeated keys at any depth —
 * including inside opaque `parameters` — fail before any typed decoding.
 * An unsupported-but-valid `negotiation_version` decodes successfully: the
 * version-mismatch fallback is host policy, not grammar.
 */
export declare function decodeNegotiateRequest(bytes: JsonInput): NegotiateRequest;
/** Exactly 32 lowercase hexadecimal ASCII characters. */
export declare function isValidActivationToken(token: string): boolean;
/**
 * Decodes and fully validates one `transport.negotiate` response body
 * against the request's `offers`: the selection MUST name an exact offered
 * `(transport, capability_version)` entry (wire doc Section 7.7.2).
 */
export declare function decodeNegotiateResponse(bytes: JsonInput, offers: readonly TransportOffer[]): NegotiateResponse;
/** Decodes one candidate `transport.activate` request body (correlation 1). */
export declare function decodeActivateRequest(bytes: JsonInput): ActivateRequest;
/**
 * Decodes one tagged candidate `transport.activate` response body. Carries
 * no provider data: any additional field is malformed (wire doc Section
 * 7.7.4).
 */
export declare function decodeActivateResponse(bytes: JsonInput): void;
/** Decodes one candidate `transport.commit` request body (correlation 2). */
export declare function decodeCommitRequest(bytes: JsonInput): void;
/** Decodes one tagged candidate `transport.commit` response body. */
export declare function decodeCommitResponse(bytes: JsonInput): void;
/**
 * Encode-side counterpart of `checkOpaque`: the same object, depth, and
 * compact-size bounds, applied to a provider-supplied value about to be
 * serialized, so a provider cannot push an out-of-contract offer or
 * descriptor onto the wire and burn the generation on the host's reject.
 * Bounds are checked on the SERIALIZED form — `toJSON`, `Date`, dropped
 * `undefined` members, and other JavaScript-only shapes all differ from
 * their pre-serialization value — and the returned parsed snapshot is what
 * callers MUST encode: a stateful `toJSON` could otherwise pass validation
 * and emit a different shape on the second serialization. Note that
 * `JSON.stringify` may run provider-authored `toJSON`; callers holding a
 * provider-owned value contain that call and pass the string to
 * {@link checkOpaqueSerialized} instead.
 */
export declare function checkOpaquePlain(value: unknown, path: string): OpaqueObject;
/**
 * `JSON.stringify` with a conservative running size estimate that aborts
 * past {@link SERIALIZE_HARD_LIMIT}, so an oversized value is rejected
 * during traversal instead of allocating its full text. Returns `undefined`
 * for a non-serializable value (the caller reports `invalid_type`), throws
 * `opaque_too_large` when the estimate trips, and lets any other throw —
 * notably a provider-authored `toJSON` — propagate to its own containment.
 */
export declare function serializeOpaqueBounded(value: unknown, path: string): string | undefined;
/**
 * Validates one already-serialized opaque value — pure data, no provider
 * code — against the object, depth, and compact-size bounds, returning the
 * parsed snapshot to encode.
 */
export declare function checkOpaqueSerialized(serialized: string | undefined, path: string): OpaqueObject;
/**
 * Encodes one compact canonical `transport.negotiate` request after
 * revalidating the same bounds the decoder enforces, so a conforming
 * encoder cannot emit out-of-contract bytes.
 */
export declare function encodeNegotiateRequest(request: NegotiateRequest): Uint8Array;
/** Encodes one compact canonical `transport.negotiate` response. */
export declare function encodeNegotiateResponse(response: NegotiateResponse): Uint8Array;
/** Encodes the candidate `transport.activate` request (correlation 1). */
export declare function encodeActivateRequest(activationToken: string): Uint8Array;
/** The tagged candidate `transport.activate` response (correlation 1). */
export declare function activateResponseJson(): Uint8Array;
/** The candidate `transport.commit` request (correlation 2). */
export declare function commitRequestJson(): Uint8Array;
/** The tagged candidate `transport.commit` response (correlation 2). */
export declare function commitResponseJson(): Uint8Array;
export {};
//# sourceMappingURL=transport-negotiation.d.ts.map