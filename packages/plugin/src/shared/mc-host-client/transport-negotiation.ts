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

const OP_TRANSPORT_NEGOTIATE = "transport.negotiate";
const OP_TRANSPORT_ACTIVATE = "transport.activate";
const OP_TRANSPORT_COMMIT = "transport.commit";

/** The negotiation grammar version this module implements. */
export const NEGOTIATION_VERSION = 1;
/** The required fallback transport name (wire doc Section 7.7.2). */
export const TRANSPORT_TCP = "tcp";
/** Offers are ordered by client preference, 1 to 8 entries. */
export const MAX_OFFERS = 8;
/** Transport names are 1-32 ASCII bytes matching `^[a-z][a-z0-9._-]{0,31}$`. */
export const MAX_TRANSPORT_NAME_BYTES = 32;
/** Opaque `parameters`/`descriptor` compact-JSON sub-cap in bytes. */
export const MAX_OPAQUE_BYTES = 8192;
/** Opaque `parameters`/`descriptor` nesting bound (Section 7.1 counting). */
export const MAX_OPAQUE_DEPTH = 8;
/** Activation tokens are exactly 32 lowercase hexadecimal characters. */
export const ACTIVATION_TOKEN_LEN = 32;
/** Versions are JSON integers in `1..=u32::MAX`. */
const MAX_VERSION = 4_294_967_295;

/** Candidate consumer correlation reserved for `transport.activate`. */
export const ACTIVATION_CORRELATION = 1n;
/** Candidate consumer correlation reserved for `transport.commit`. */
export const COMMIT_CORRELATION = 2n;
/** First candidate consumer correlation available to application requests. */
export const FIRST_APPLICATION_CORRELATION = 3n;

/** Bounded decode/encode failure taxonomy, mirrored by the Rust host. */
export type NegotiationErrorCode =
    | "malformed_json"
    | "invalid_type"
    | "missing_field"
    | "unexpected_field"
    | "invalid_version"
    | "invalid_transport_name"
    | "invalid_offer_count"
    | "duplicate_offer"
    | "missing_tcp_offer"
    | "opaque_too_large"
    | "opaque_too_deep"
    | "invalid_activation_token"
    | "invalid_reason"
    | "unoffered_selection"
    | "wrong_operation";

/**
 * One negotiation decode/encode failure: a bounded code plus a structural
 * field path built only from documented field names and offer indices.
 * Client- or host-supplied bytes — unknown key names, provider parameters,
 * descriptors, and tokens — never appear here.
 */
export class NegotiationError extends Error {
    constructor(
        readonly code: NegotiationErrorCode,
        readonly path: string,
    ) {
        super(`${code} at ${path}`);
        this.name = "NegotiationError";
    }
}

/** Closed fallback vocabulary (wire doc Section 7.7.3). */
export const FALLBACK_REASONS = [
    "unavailable",
    "negotiation_version_mismatch",
    "capability_version_mismatch",
    "connection_in_use",
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

function isFallbackReason(value: string): value is FallbackReason {
    return (FALLBACK_REASONS as readonly string[]).includes(value);
}

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
export type NegotiateResponse =
    | { kind: "tcp"; selected: SelectedTransport; reason?: FallbackReason }
    | {
          kind: "grant";
          selected: SelectedTransport;
          activationToken: string;
          descriptor: OpaqueObject;
      };

/** The validated candidate `transport.activate` request (correlation 1). */
export interface ActivateRequest {
    activationToken: string;
}

/**
 * Strict JSON value with per-value metadata the standard `JSON.parse` cannot
 * provide: duplicate-key rejection at every depth and the raw number
 * literal, so `1.0` and `1e2` stay distinguishable from `1`.
 */
type StrictValue =
    | { kind: "null" }
    | { kind: "boolean"; value: boolean }
    | { kind: "string"; value: string }
    | { kind: "number"; value: number; raw: string }
    | { kind: "array"; items: StrictValue[] }
    | { kind: "object"; entries: Map<string, StrictValue> };

/** Matches serde_json's default recursion limit so both decoders agree. */
const PARSER_RECURSION_LIMIT = 128;

/**
 * Recursive-descent strict JSON parser. Rejects duplicate object keys at
 * any depth, invalid UTF-8, trailing content, and out-of-grammar numbers —
 * all before any typed decoding sees the document.
 */
class StrictJsonParser {
    private pos = 0;

    constructor(private readonly text: string) {}

    parse(): StrictValue {
        const value = this.parseValue(0);
        this.skipWhitespace();
        if (this.pos !== this.text.length) {
            throw new NegotiationError("malformed_json", "body");
        }
        return value;
    }

    private fail(): never {
        throw new NegotiationError("malformed_json", "body");
    }

    private skipWhitespace(): void {
        while (this.pos < this.text.length) {
            const ch = this.text[this.pos];
            if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
                this.pos++;
            } else {
                break;
            }
        }
    }

    private parseValue(depth: number): StrictValue {
        if (depth > PARSER_RECURSION_LIMIT) this.fail();
        this.skipWhitespace();
        const ch = this.text[this.pos];
        if (ch === undefined) this.fail();
        if (ch === "{") return this.parseObject(depth);
        if (ch === "[") return this.parseArray(depth);
        if (ch === '"') return { kind: "string", value: this.parseString() };
        if (ch === "t") return this.parseLiteral("true", { kind: "boolean", value: true });
        if (ch === "f") return this.parseLiteral("false", { kind: "boolean", value: false });
        if (ch === "n") return this.parseLiteral("null", { kind: "null" });
        return this.parseNumber();
    }

    private parseLiteral(literal: string, value: StrictValue): StrictValue {
        if (this.text.startsWith(literal, this.pos)) {
            this.pos += literal.length;
            return value;
        }
        this.fail();
    }

    private parseObject(depth: number): StrictValue {
        this.pos++; // consume '{'
        const entries = new Map<string, StrictValue>();
        this.skipWhitespace();
        if (this.text[this.pos] === "}") {
            this.pos++;
            return { kind: "object", entries };
        }
        for (;;) {
            this.skipWhitespace();
            if (this.text[this.pos] !== '"') this.fail();
            const key = this.parseString();
            if (entries.has(key)) {
                // Duplicate keys are rejected outright, at every depth, so
                // no later consumer can depend on decoder or field order.
                this.fail();
            }
            this.skipWhitespace();
            if (this.text[this.pos] !== ":") this.fail();
            this.pos++;
            entries.set(key, this.parseValue(depth + 1));
            this.skipWhitespace();
            const next = this.text[this.pos];
            if (next === ",") {
                this.pos++;
                continue;
            }
            if (next === "}") {
                this.pos++;
                return { kind: "object", entries };
            }
            this.fail();
        }
    }

    private parseArray(depth: number): StrictValue {
        this.pos++; // consume '['
        const items: StrictValue[] = [];
        this.skipWhitespace();
        if (this.text[this.pos] === "]") {
            this.pos++;
            return { kind: "array", items };
        }
        for (;;) {
            items.push(this.parseValue(depth + 1));
            this.skipWhitespace();
            const next = this.text[this.pos];
            if (next === ",") {
                this.pos++;
                continue;
            }
            if (next === "]") {
                this.pos++;
                return { kind: "array", items };
            }
            this.fail();
        }
    }

    private parseString(): string {
        this.pos++; // consume '"'
        let out = "";
        for (;;) {
            const ch = this.text[this.pos];
            if (ch === undefined) this.fail();
            if (ch === '"') {
                this.pos++;
                return out;
            }
            if (ch === "\\") {
                this.pos++;
                out += this.parseEscape();
                continue;
            }
            const codePoint = ch.codePointAt(0) as number;
            if (codePoint < 0x20) this.fail();
            if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
                // A raw lone surrogate cannot come from valid UTF-8 input;
                // paired surrogates arrive as one code point.
                const pair = this.text.codePointAt(this.pos) as number;
                if (pair >= 0xd800 && pair <= 0xdfff) this.fail();
                out += String.fromCodePoint(pair);
                this.pos += 2;
                continue;
            }
            out += ch;
            this.pos++;
        }
    }

    private parseEscape(): string {
        const ch = this.text[this.pos];
        this.pos++;
        switch (ch) {
            case '"':
                return '"';
            case "\\":
                return "\\";
            case "/":
                return "/";
            case "b":
                return "\b";
            case "f":
                return "\f";
            case "n":
                return "\n";
            case "r":
                return "\r";
            case "t":
                return "\t";
            case "u": {
                const first = this.parseHex4();
                if (first >= 0xd800 && first <= 0xdbff) {
                    // Require a full surrogate pair, matching serde_json.
                    if (this.text[this.pos] !== "\\" || this.text[this.pos + 1] !== "u") {
                        this.fail();
                    }
                    this.pos += 2;
                    const second = this.parseHex4();
                    if (second < 0xdc00 || second > 0xdfff) this.fail();
                    return String.fromCharCode(first, second);
                }
                if (first >= 0xdc00 && first <= 0xdfff) this.fail();
                return String.fromCharCode(first);
            }
            default:
                this.fail();
        }
    }

    private parseHex4(): number {
        const hex = this.text.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail();
        this.pos += 4;
        return Number.parseInt(hex, 16);
    }

    private parseNumber(): StrictValue {
        const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
            this.text.slice(this.pos),
        );
        if (!match || match[0].length === 0) this.fail();
        const raw = match[0];
        this.pos += raw.length;
        const value = Number(raw);
        // Non-finite numbers are out of range for JSON, matching serde_json.
        if (!Number.isFinite(value)) this.fail();
        return { kind: "number", value, raw };
    }
}

function parseStrict(bytes: Uint8Array): StrictValue {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new NegotiationError("malformed_json", "body");
    }
    return new StrictJsonParser(text).parse();
}

function requireRootObject(bytes: Uint8Array): Map<string, StrictValue> {
    const root = parseStrict(bytes);
    if (root.kind !== "object") {
        throw new NegotiationError("invalid_type", "body");
    }
    return root.entries;
}

/**
 * Rejects any key outside `allowed`. The unknown key itself is peer-supplied
 * and is deliberately not echoed into the error path.
 */
function checkClosedFields(
    fields: Map<string, StrictValue>,
    allowed: readonly string[],
    path: string,
): void {
    for (const key of fields.keys()) {
        if (!allowed.includes(key)) {
            throw new NegotiationError("unexpected_field", path);
        }
    }
}

function requireOp(fields: Map<string, StrictValue>, expected: string): void {
    const op = fields.get("op");
    if (op === undefined) throw new NegotiationError("missing_field", "op");
    if (op.kind !== "string") throw new NegotiationError("invalid_type", "op");
    if (op.value !== expected) throw new NegotiationError("wrong_operation", "op");
}

/**
 * A version field is a JSON integer in `1..=u32::MAX`. The raw literal is
 * checked, so `1.0` and `1e2` fail exactly like they do in the Rust decoder
 * (where they parse as floats).
 */
function requireVersion(fields: Map<string, StrictValue>, key: string, path: string): number {
    const value = fields.get(key);
    if (value === undefined) throw new NegotiationError("missing_field", path);
    if (value.kind !== "number") throw new NegotiationError("invalid_type", path);
    if (!/^(?:0|[1-9]\d*)$/.test(value.raw)) {
        throw new NegotiationError("invalid_version", path);
    }
    if (value.value < 1 || value.value > MAX_VERSION) {
        throw new NegotiationError("invalid_version", path);
    }
    return value.value;
}

const TRANSPORT_NAME_RE = /^[a-z][a-z0-9._-]{0,31}$/;

function validTransportName(name: string): boolean {
    return TRANSPORT_NAME_RE.test(name);
}

function requireTransportName(fields: Map<string, StrictValue>, pathPrefix: string): string {
    const path = `${pathPrefix}.transport`;
    const value = fields.get("transport");
    if (value === undefined) throw new NegotiationError("missing_field", path);
    if (value.kind !== "string") throw new NegotiationError("invalid_type", path);
    if (!validTransportName(value.value)) {
        throw new NegotiationError("invalid_transport_name", path);
    }
    return value.value;
}

type PlainJson = null | boolean | string | number | PlainJson[] | { [key: string]: PlainJson };

const INTEGER_LITERAL_RE = /^-?(?:0|[1-9]\d*)$/;

function strictToPlain(value: StrictValue, path: string): PlainJson {
    switch (value.kind) {
        case "null":
            return null;
        case "boolean":
        case "string":
            return value.value;
        case "number":
            // A JSON integer beyond the double-safe range would silently
            // round (9007199254740993 becomes ...992), handing the provider
            // altered identifiers. This client cannot represent it
            // faithfully, so it is rejected rather than corrupted.
            if (INTEGER_LITERAL_RE.test(value.raw) && !Number.isSafeInteger(value.value)) {
                throw new NegotiationError("invalid_type", path);
            }
            return value.value;
        case "array":
            return value.items.map((item) => strictToPlain(item, path));
        case "object": {
            // Null prototype: an own `"__proto__"` key must become an own
            // data property. Assigning it onto `{}` would invoke the
            // inherited prototype setter, handing the provider altered
            // descriptor data and hiding the subtree from the
            // `JSON.stringify` size bound in `checkOpaque`.
            const out: { [key: string]: PlainJson } = Object.create(null) as {
                [key: string]: PlainJson;
            };
            for (const [key, entry] of value.entries) {
                out[key] = strictToPlain(entry, path);
            }
            return out;
        }
    }
}

/**
 * Container depth (wire doc §7.1): 1 at the subtree root, +1 per nested
 * object/array. Scalar leaves add no level, so `{"a":1}` is depth 1.
 */
function strictDepth(value: StrictValue): number {
    switch (value.kind) {
        case "array":
            return 1 + value.items.reduce((max, item) => Math.max(max, strictDepth(item)), 0);
        case "object": {
            let max = 0;
            for (const entry of value.entries.values()) {
                max = Math.max(max, strictDepth(entry));
            }
            return 1 + max;
        }
        default:
            return 0;
    }
}

/**
 * Opaque `parameters`/`descriptor` bounds: a JSON object at most
 * {@link MAX_OPAQUE_BYTES} compact bytes and {@link MAX_OPAQUE_DEPTH} levels
 * deep. Duplicate keys inside the value were already rejected by the strict
 * parse.
 */
function checkOpaque(value: StrictValue, path: string): OpaqueObject {
    if (value.kind !== "object") throw new NegotiationError("invalid_type", path);
    const plain = strictToPlain(value, path) as OpaqueObject;
    const compactBytes = new TextEncoder().encode(JSON.stringify(plain)).length;
    if (compactBytes > MAX_OPAQUE_BYTES) {
        throw new NegotiationError("opaque_too_large", path);
    }
    if (strictDepth(value) > MAX_OPAQUE_DEPTH) {
        throw new NegotiationError("opaque_too_deep", path);
    }
    return plain;
}

function decodeOffers(fields: Map<string, StrictValue>): TransportOffer[] {
    const value = fields.get("offers");
    if (value === undefined) throw new NegotiationError("missing_field", "offers");
    if (value.kind !== "array") throw new NegotiationError("invalid_type", "offers");
    if (value.items.length === 0 || value.items.length > MAX_OFFERS) {
        throw new NegotiationError("invalid_offer_count", "offers");
    }

    const offers: TransportOffer[] = [];
    for (const [index, entry] of value.items.entries()) {
        const path = `offers[${index}]`;
        if (entry.kind !== "object") throw new NegotiationError("invalid_type", path);
        checkClosedFields(entry.entries, ["transport", "capability_version", "parameters"], path);
        const transport = requireTransportName(entry.entries, path);
        const capabilityVersion = requireVersion(
            entry.entries,
            "capability_version",
            `${path}.capability_version`,
        );
        const parametersValue = entry.entries.get("parameters");
        const parameters =
            parametersValue === undefined
                ? undefined
                : checkOpaque(parametersValue, `${path}.parameters`);
        if (
            offers.some(
                (prior) =>
                    prior.transport === transport && prior.capabilityVersion === capabilityVersion,
            )
        ) {
            throw new NegotiationError("duplicate_offer", path);
        }
        offers.push(
            parameters === undefined
                ? { transport, capabilityVersion }
                : { transport, capabilityVersion, parameters },
        );
    }

    if (!offers.some((offer) => offer.transport === TRANSPORT_TCP)) {
        throw new NegotiationError("missing_tcp_offer", "offers");
    }
    return offers;
}

/**
 * Decodes and fully validates one `transport.negotiate` request body. The
 * duplicate-aware parse runs first, so repeated keys at any depth —
 * including inside opaque `parameters` — fail before any typed decoding.
 * An unsupported-but-valid `negotiation_version` decodes successfully: the
 * version-mismatch fallback is host policy, not grammar.
 */
export function decodeNegotiateRequest(bytes: Uint8Array): NegotiateRequest {
    const fields = requireRootObject(bytes);
    checkClosedFields(fields, ["op", "negotiation_version", "offers"], "body");
    requireOp(fields, OP_TRANSPORT_NEGOTIATE);
    const negotiationVersion = requireVersion(fields, "negotiation_version", "negotiation_version");
    const offers = decodeOffers(fields);
    return { negotiationVersion, offers };
}

const ACTIVATION_TOKEN_RE = /^[0-9a-f]{32}$/;

/** Exactly 32 lowercase hexadecimal ASCII characters. */
export function isValidActivationToken(token: string): boolean {
    return ACTIVATION_TOKEN_RE.test(token);
}

function requireActivationToken(fields: Map<string, StrictValue>): string {
    const value = fields.get("activation_token");
    if (value === undefined) throw new NegotiationError("missing_field", "activation_token");
    if (value.kind !== "string") throw new NegotiationError("invalid_type", "activation_token");
    if (!isValidActivationToken(value.value)) {
        throw new NegotiationError("invalid_activation_token", "activation_token");
    }
    return value.value;
}

/**
 * Decodes and fully validates one `transport.negotiate` response body
 * against the request's `offers`: the selection MUST name an exact offered
 * `(transport, capability_version)` entry (wire doc Section 7.7.2).
 */
export function decodeNegotiateResponse(
    bytes: Uint8Array,
    offers: readonly TransportOffer[],
): NegotiateResponse {
    const fields = requireRootObject(bytes);
    checkClosedFields(
        fields,
        ["op", "negotiation_version", "selected", "reason", "activation_token", "descriptor"],
        "body",
    );
    requireOp(fields, OP_TRANSPORT_NEGOTIATE);
    const version = requireVersion(fields, "negotiation_version", "negotiation_version");
    if (version !== NEGOTIATION_VERSION) {
        throw new NegotiationError("invalid_version", "negotiation_version");
    }

    const selectedValue = fields.get("selected");
    if (selectedValue === undefined) throw new NegotiationError("missing_field", "selected");
    if (selectedValue.kind !== "object") throw new NegotiationError("invalid_type", "selected");
    checkClosedFields(selectedValue.entries, ["transport", "capability_version"], "selected");
    const transport = requireTransportName(selectedValue.entries, "selected");
    const capabilityVersion = requireVersion(
        selectedValue.entries,
        "capability_version",
        "selected.capability_version",
    );
    if (
        !offers.some(
            (offer) =>
                offer.transport === transport && offer.capabilityVersion === capabilityVersion,
        )
    ) {
        throw new NegotiationError("unoffered_selection", "selected");
    }
    const selected: SelectedTransport = { transport, capabilityVersion };

    if (transport === TRANSPORT_TCP) {
        if (fields.has("activation_token")) {
            throw new NegotiationError("unexpected_field", "activation_token");
        }
        if (fields.has("descriptor")) {
            throw new NegotiationError("unexpected_field", "descriptor");
        }
        const reasonValue = fields.get("reason");
        if (reasonValue === undefined) return { kind: "tcp", selected };
        if (reasonValue.kind !== "string") throw new NegotiationError("invalid_type", "reason");
        if (!isFallbackReason(reasonValue.value)) {
            throw new NegotiationError("invalid_reason", "reason");
        }
        return { kind: "tcp", selected, reason: reasonValue.value };
    }

    if (fields.has("reason")) {
        throw new NegotiationError("unexpected_field", "reason");
    }
    const activationToken = requireActivationToken(fields);
    const descriptorValue = fields.get("descriptor");
    if (descriptorValue === undefined) throw new NegotiationError("missing_field", "descriptor");
    const descriptor = checkOpaque(descriptorValue, "descriptor");
    return { kind: "grant", selected, activationToken, descriptor };
}

/** Decodes one candidate `transport.activate` request body (correlation 1). */
export function decodeActivateRequest(bytes: Uint8Array): ActivateRequest {
    const fields = requireRootObject(bytes);
    checkClosedFields(fields, ["op", "negotiation_version", "activation_token"], "body");
    requireOp(fields, OP_TRANSPORT_ACTIVATE);
    requireExactVersion(fields);
    return { activationToken: requireActivationToken(fields) };
}

/**
 * Decodes one tagged candidate `transport.activate` response body. Carries
 * no provider data: any additional field is malformed (wire doc Section
 * 7.7.4).
 */
export function decodeActivateResponse(bytes: Uint8Array): void {
    decodeTaggedOnly(bytes, OP_TRANSPORT_ACTIVATE);
}

/** Decodes one candidate `transport.commit` request body (correlation 2). */
export function decodeCommitRequest(bytes: Uint8Array): void {
    decodeTaggedOnly(bytes, OP_TRANSPORT_COMMIT);
}

/** Decodes one tagged candidate `transport.commit` response body. */
export function decodeCommitResponse(bytes: Uint8Array): void {
    decodeTaggedOnly(bytes, OP_TRANSPORT_COMMIT);
}

function decodeTaggedOnly(bytes: Uint8Array, op: string): void {
    const fields = requireRootObject(bytes);
    checkClosedFields(fields, ["op", "negotiation_version"], "body");
    requireOp(fields, op);
    requireExactVersion(fields);
}

/**
 * The closed set of legacy Error terminal codes that prove
 * `transport.negotiate` was never dispatched, so selecting TCP on this
 * connection is safe (KTD6). Wire doc §7.7.3 names the exact legacy
 * `unsupported_operation` terminal as the ONLY Error-based continuation
 * evidence. `server_busy` is deliberately excluded: the doc permits a
 * compliant negotiation-aware host to reject any control request before
 * dispatch under load, so the code is not unambiguous legacy evidence —
 * and it is independently retryable, which retirement plus reconnect
 * already provides.
 *
 * Every other Error body is malformed negotiation content and fails closed.
 */
const LEGACY_FALLBACK_CODES: readonly string[] = ["unsupported_operation"];

/**
 * The `code` of a strict legacy Error terminal: UTF-8 JSON `{code, message}`
 * with both fields strings, no extra fields, and no duplicate keys.
 * `undefined` for anything else, so a malformed body can never be read as
 * fallback evidence.
 */
function legacyErrorCode(bytes: Uint8Array): string | undefined {
    let fields: Map<string, StrictValue>;
    try {
        fields = requireRootObject(bytes);
        checkClosedFields(fields, ["code", "message"], "body");
    } catch {
        return undefined;
    }
    const code = fields.get("code");
    const message = fields.get("message");
    if (code === undefined || code.kind !== "string") return undefined;
    if (message === undefined || message.kind !== "string") return undefined;
    return code.value;
}

/**
 * True only for the exact legacy `unsupported_operation` Error terminal:
 * strict UTF-8 JSON `{code, message}` with both fields strings, no extras,
 * and no duplicate keys.
 */
export function isLegacyUnsupportedOperationBody(bytes: Uint8Array): boolean {
    return legacyErrorCode(bytes) === "unsupported_operation";
}

/**
 * True for the closed set of legacy Error terminals that may select TCP
 * fallback (KTD6); see {@link LEGACY_FALLBACK_CODES}. A body with extra
 * fields, a non-string message, or any other code fails closed.
 */
export function isLegacyFallbackTerminalBody(bytes: Uint8Array): boolean {
    const code = legacyErrorCode(bytes);
    return code !== undefined && LEGACY_FALLBACK_CODES.includes(code);
}

function requireExactVersion(fields: Map<string, StrictValue>): void {
    const version = requireVersion(fields, "negotiation_version", "negotiation_version");
    if (version !== NEGOTIATION_VERSION) {
        throw new NegotiationError("invalid_version", "negotiation_version");
    }
}

function checkVersionRange(version: number, path: string): void {
    if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
        throw new NegotiationError("invalid_version", path);
    }
}

/** Container depth of a plain value; same §7.1 counting as `strictDepth`. */
function plainDepth(value: unknown): number {
    if (Array.isArray(value)) {
        return 1 + value.reduce((max: number, item) => Math.max(max, plainDepth(item)), 0);
    }
    if (typeof value === "object" && value !== null) {
        let max = 0;
        for (const entry of Object.values(value)) {
            max = Math.max(max, plainDepth(entry));
        }
        return 1 + max;
    }
    return 0;
}

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
export function checkOpaquePlain(value: unknown, path: string): OpaqueObject {
    return checkOpaqueSerialized(JSON.stringify(value), path);
}

/**
 * Validates one already-serialized opaque value — pure data, no provider
 * code — against the object, depth, and compact-size bounds, returning the
 * parsed snapshot to encode.
 */
export function checkOpaqueSerialized(serialized: string | undefined, path: string): OpaqueObject {
    if (serialized === undefined) {
        throw new NegotiationError("invalid_type", path);
    }
    if (new TextEncoder().encode(serialized).length > MAX_OPAQUE_BYTES) {
        throw new NegotiationError("opaque_too_large", path);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized) as unknown;
    } catch {
        throw new NegotiationError("invalid_type", path);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new NegotiationError("invalid_type", path);
    }
    if (plainDepth(parsed) > MAX_OPAQUE_DEPTH) {
        throw new NegotiationError("opaque_too_deep", path);
    }
    assertWellFormedStrings(parsed, path);
    return parsed as OpaqueObject;
}

/** A UTF-16 code unit in the surrogate range without its required partner. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Rejects strings (values and keys) containing lone surrogates.
 * `JSON.stringify` escapes them (`\ud800`) rather than failing, but the
 * host's strict UTF-8 decoder rejects unpaired surrogate escapes — the
 * client must fail locally instead of burning the authenticated generation
 * on the host's reject.
 */
function assertWellFormedStrings(value: unknown, path: string): void {
    if (typeof value === "string") {
        if (LONE_SURROGATE_RE.test(value)) {
            throw new NegotiationError("invalid_type", path);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) assertWellFormedStrings(item, path);
        return;
    }
    if (typeof value === "object" && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
            if (LONE_SURROGATE_RE.test(key)) {
                throw new NegotiationError("invalid_type", path);
            }
            assertWellFormedStrings(entry, path);
        }
    }
}

/**
 * Encodes one compact canonical `transport.negotiate` request after
 * revalidating the same bounds the decoder enforces, so a conforming
 * encoder cannot emit out-of-contract bytes.
 */
export function encodeNegotiateRequest(request: NegotiateRequest): Uint8Array {
    checkVersionRange(request.negotiationVersion, "negotiation_version");
    if (request.offers.length === 0 || request.offers.length > MAX_OFFERS) {
        throw new NegotiationError("invalid_offer_count", "offers");
    }
    const wireOffers = request.offers.map((offer, index) => {
        const path = `offers[${index}]`;
        if (!validTransportName(offer.transport)) {
            throw new NegotiationError("invalid_transport_name", `${path}.transport`);
        }
        checkVersionRange(offer.capabilityVersion, `${path}.capability_version`);
        if (
            request.offers
                .slice(0, index)
                .some(
                    (prior) =>
                        prior.transport === offer.transport &&
                        prior.capabilityVersion === offer.capabilityVersion,
                )
        ) {
            throw new NegotiationError("duplicate_offer", path);
        }
        // The validated snapshot — not the original value — reaches the
        // wire, so what was checked is exactly what is sent.
        const parameters =
            offer.parameters === undefined
                ? undefined
                : checkOpaquePlain(offer.parameters, `${path}.parameters`);
        return parameters === undefined
            ? { transport: offer.transport, capability_version: offer.capabilityVersion }
            : {
                  transport: offer.transport,
                  capability_version: offer.capabilityVersion,
                  parameters,
              };
    });
    if (!request.offers.some((offer) => offer.transport === TRANSPORT_TCP)) {
        throw new NegotiationError("missing_tcp_offer", "offers");
    }
    return new TextEncoder().encode(
        JSON.stringify({
            op: OP_TRANSPORT_NEGOTIATE,
            negotiation_version: request.negotiationVersion,
            offers: wireOffers,
        }),
    );
}

/** Encodes one compact canonical `transport.negotiate` response. */
export function encodeNegotiateResponse(response: NegotiateResponse): Uint8Array {
    const selected = response.selected;
    checkVersionRange(selected.capabilityVersion, "selected.capability_version");
    if (response.kind === "tcp") {
        if (selected.transport !== TRANSPORT_TCP) {
            throw new NegotiationError("invalid_transport_name", "selected.transport");
        }
        const body: Record<string, unknown> = {
            op: OP_TRANSPORT_NEGOTIATE,
            negotiation_version: NEGOTIATION_VERSION,
            selected: {
                transport: selected.transport,
                capability_version: selected.capabilityVersion,
            },
        };
        if (response.reason !== undefined) body.reason = response.reason;
        return new TextEncoder().encode(JSON.stringify(body));
    }
    if (!validTransportName(selected.transport) || selected.transport === TRANSPORT_TCP) {
        throw new NegotiationError("invalid_transport_name", "selected.transport");
    }
    if (!isValidActivationToken(response.activationToken)) {
        throw new NegotiationError("invalid_activation_token", "activation_token");
    }
    // The validated snapshot — not the original value — reaches the wire.
    const descriptor = checkOpaquePlain(response.descriptor, "descriptor");
    return new TextEncoder().encode(
        JSON.stringify({
            op: OP_TRANSPORT_NEGOTIATE,
            negotiation_version: NEGOTIATION_VERSION,
            selected: {
                transport: selected.transport,
                capability_version: selected.capabilityVersion,
            },
            activation_token: response.activationToken,
            descriptor,
        }),
    );
}

/** Encodes the candidate `transport.activate` request (correlation 1). */
export function encodeActivateRequest(activationToken: string): Uint8Array {
    if (!isValidActivationToken(activationToken)) {
        throw new NegotiationError("invalid_activation_token", "activation_token");
    }
    return new TextEncoder().encode(
        JSON.stringify({
            op: OP_TRANSPORT_ACTIVATE,
            negotiation_version: NEGOTIATION_VERSION,
            activation_token: activationToken,
        }),
    );
}

/**
 * One `{op, negotiation_version}` candidate body. Built from the module
 * constants rather than a frozen literal so a {@link NEGOTIATION_VERSION}
 * bump cannot leave these emitting a version their own decoders reject.
 */
function taggedBody(op: string): Uint8Array {
    return new TextEncoder().encode(
        JSON.stringify({ op, negotiation_version: NEGOTIATION_VERSION }),
    );
}

/** The tagged candidate `transport.activate` response (correlation 1). */
export function activateResponseJson(): Uint8Array {
    return taggedBody(OP_TRANSPORT_ACTIVATE);
}

/** The candidate `transport.commit` request (correlation 2). */
export function commitRequestJson(): Uint8Array {
    return taggedBody(OP_TRANSPORT_COMMIT);
}

/** The tagged candidate `transport.commit` response (correlation 2). */
export function commitResponseJson(): Uint8Array {
    return taggedBody(OP_TRANSPORT_COMMIT);
}
