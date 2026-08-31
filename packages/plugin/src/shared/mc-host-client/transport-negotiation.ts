/**
 * This module implements version 1 of the mc-host direct-profile negotiation wire grammar.
 * 7.7).
 *
 * The decoder enforces closed field sets and exact bounds.
 * The JSON parser rejects duplicate object keys at every depth, including opaque values.
 * Decode failures contain only a bounded code and structural field path.
 * Error messages never include provider bytes, tokens, or descriptors.
 */

const OP_TRANSPORT_NEGOTIATE = "transport.negotiate";
const OP_TRANSPORT_ACTIVATE = "transport.activate";
const OP_TRANSPORT_COMMIT = "transport.commit";

/* */
export const NEGOTIATION_VERSION = 1;
/** `tcp` is the required fallback transport name. */
export const TRANSPORT_TCP = "tcp";
/** Offers are ordered by client preference, 1 to 8 entries. */
export const MAX_OFFERS = 8;
/** Transport names are 1-32 ASCII bytes matching `^[a-z][a-z0-9._-]{0,31}$`. */
export const MAX_TRANSPORT_NAME_BYTES = 32;
/** Opaque `parameters` and `descriptor` values each occupy at most 8192 compact-JSON bytes. */
export const MAX_OPAQUE_BYTES = 8192;
/** Opaque `parameters` and `descriptor` values may nest at most 8 levels. */
export const MAX_OPAQUE_DEPTH = 8;
/** Activation tokens are exactly 32 lowercase hexadecimal characters. */
export const ACTIVATION_TOKEN_LEN = 32;
/** Versions are JSON integers in `1..=u32::MAX`. */
const MAX_VERSION = 4_294_967_295;

/** `transport.activate` reserves consumer correlation `1n`. */
export const ACTIVATION_CORRELATION = 1n;
/** `transport.commit` reserves consumer correlation `2n`. */
export const COMMIT_CORRELATION = 2n;
/** Application requests may use consumer correlations starting at `3n`. */
export const FIRST_APPLICATION_CORRELATION = 3n;

/** Decode and encode failures use only `NegotiationErrorCode`. */
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
 * Error messages never include client- or host-supplied bytes.
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

/**
 *
 */
export const FALLBACK_REASONS = ["unavailable", "capability_version_mismatch"] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

function isFallbackReason(value: string): value is FallbackReason {
    return (FALLBACK_REASONS as readonly string[]).includes(value);
}

/** Opaque provider data: a bounded JSON object the core never interprets. */
export type OpaqueObject = Record<string, unknown>;

/* */
export interface TransportOffer {
    transport: string;
    capabilityVersion: number;
    parameters?: OpaqueObject;
}

/** The decoder returns `NegotiateRequest` only after validation. */
export interface NegotiateRequest {
    negotiationVersion: number;
    offers: TransportOffer[];
}

/** A response must name an offered `transport` and `capabilityVersion` pair. */
interface SelectedTransport {
    transport: string;
    capabilityVersion: number;
}

/**
 */
export type NegotiateResponse =
    | { kind: "tcp"; selected: SelectedTransport; reason?: FallbackReason }
    | {
          kind: "grant";
          selected: SelectedTransport;
          activationToken: string;
          descriptor: OpaqueObject;
      };

/** The decoder accepts `ActivateRequest` only with correlation `1n`. */
export interface ActivateRequest {
    activationToken: string;
}

/**
 * `StrictValue` preserves duplicate keys and raw number literals so typed decoding can reject duplicates and distinguish `1.0` and `1e2` from `1`.
 */
type StrictValue =
    | { kind: "null" }
    | { kind: "boolean"; value: boolean }
    | { kind: "string"; value: string }
    | { kind: "number"; value: number; raw: string }
    | { kind: "array"; items: StrictValue[] }
    | { kind: "object"; entries: Map<string, StrictValue> };

/** The recursion limit matches serde_json's default so both decoders agree. */
const PARSER_RECURSION_LIMIT = 128;

/**
 * The parser rejects duplicate keys at every depth, invalid UTF-8, trailing content, and out-of-grammar numbers before typed decoding.
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
                // Duplicate keys are rejected at every depth, preventing decoder- or field-order-dependent interpretation.
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
                    // A high surrogate must be followed by a `\u`-encoded low surrogate.
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
        if (!Number.isFinite(value)) this.fail();
        return { kind: "number", value, raw };
    }
}

type JsonInput = Uint8Array | string;

function parseStrict(bytes: JsonInput): StrictValue {
    let text: string;
    try {
        text =
            typeof bytes === "string"
                ? bytes
                : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new NegotiationError("malformed_json", "body");
    }
    return new StrictJsonParser(text).parse();
}

function requireRootObject(bytes: JsonInput): Map<string, StrictValue> {
    const root = parseStrict(bytes);
    if (root.kind !== "object") {
        throw new NegotiationError("invalid_type", "body");
    }
    return root.entries;
}

/**
 * Unknown keys are rejected without echoing the peer-supplied key into the error path.
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
 * A version field must be a JSON integer in `1..=u32::MAX`; checking `value.raw` rejects `1.0` and `1e2`.
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

function strictToPlain(value: StrictValue, path: string): PlainJson {
    switch (value.kind) {
        case "null":
            return null;
        case "boolean":
        case "string":
            return value.value;
        case "number":
            // Numbers beyond the double-safe integer range are rejected because JavaScript rounds them before they reach the provider.
            // corrupted.
            if (Number.isInteger(value.value) && !Number.isSafeInteger(value.value)) {
                throw new NegotiationError("invalid_type", path);
            }
            return value.value;
        case "array":
            return value.items.map((item) => strictToPlain(item, path));
        case "object": {
            // An own `"__proto__"` key must remain an own data property rather than mutate the object's prototype.
            // Assigning an own `"__proto__"` key to `{}` invokes the inherited prototype setter instead of creating an own data property.
            // The prototype setter can hide the subtree from `JSON.stringify`, bypassing `checkOpaque`'s size bound.
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
 * Container depth is 1 at the subtree root plus 1 for each nested container.
 * Each nested object or array adds one level; scalar leaves add none, so `{"a":1}` has depth 1.
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
 * Opaque `parameters` and `descriptor` values must be JSON objects no larger than `MAX_OPAQUE_BYTES` compact bytes.
 * Opaque values must not exceed `MAX_OPAQUE_BYTES` compact bytes or `MAX_OPAQUE_DEPTH` levels.
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
 */
export function decodeNegotiateRequest(bytes: JsonInput): NegotiateRequest {
    const fields = requireRootObject(bytes);
    checkClosedFields(fields, ["op", "negotiation_version", "offers"], "body");
    requireOp(fields, OP_TRANSPORT_NEGOTIATE);
    const negotiationVersion = requireVersion(fields, "negotiation_version", "negotiation_version");
    const offers = decodeOffers(fields);
    return { negotiationVersion, offers };
}

const ACTIVATION_TOKEN_RE = /^[0-9a-f]{32}$/;

/* */
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
 */
export function decodeNegotiateResponse(
    bytes: JsonInput,
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

/* */
export function decodeActivateRequest(bytes: JsonInput): ActivateRequest {
    const fields = requireRootObject(bytes);
    checkClosedFields(fields, ["op", "negotiation_version", "activation_token"], "body");
    requireOp(fields, OP_TRANSPORT_ACTIVATE);
    requireExactVersion(fields);
    return { activationToken: requireActivationToken(fields) };
}

/**
 * 7.7.4).
 */
export function decodeActivateResponse(bytes: JsonInput): void {
    decodeTaggedOnly(bytes, OP_TRANSPORT_ACTIVATE);
}

/* */
export function decodeCommitRequest(bytes: JsonInput): void {
    decodeTaggedOnly(bytes, OP_TRANSPORT_COMMIT);
}

/* */
export function decodeCommitResponse(bytes: JsonInput): void {
    decodeTaggedOnly(bytes, OP_TRANSPORT_COMMIT);
}

function decodeTaggedOnly(bytes: JsonInput, op: string): void {
    const fields = requireRootObject(bytes);
    checkClosedFields(fields, ["op", "negotiation_version"], "body");
    requireOp(fields, op);
    requireExactVersion(fields);
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

/* */
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
 * Bounds apply to the serialized form because JavaScript values can serialize differently from their in-memory representation.
 * `toJSON`, `Date`, and `undefined` members can serialize differently from their in-memory representation.
 */
export function checkOpaquePlain(value: unknown, path: string): OpaqueObject {
    return checkOpaqueSerialized(serializeOpaqueBounded(value, path), path);
}

/**
 * The estimate may exceed the emitted size, so the guard must not reject values under the exact bound.
 * `checkOpaqueSerialized` performs the authoritative exact byte check.
 * The estimate only prevents arbitrarily large provider values from being fully materialized.
 */
const SERIALIZE_HARD_LIMIT = MAX_OPAQUE_BYTES * 4;

/** `OpaqueSerializationBound` distinguishes estimate overflow from provider `toJSON` errors. */
class OpaqueSerializationBound extends Error {}

/**
 * The replacer aborts traversal when its size estimate exceeds {@link SERIALIZE_HARD_LIMIT}.
 * The function aborts traversal before materializing the full serialized text.
 * When `JSON.stringify` returns `undefined`, `checkOpaqueSerialized` throws `invalid_type`.
 * The function throws `opaque_too_large` when the estimate exceeds the limit and propagates other errors.
 */
export function serializeOpaqueBounded(value: unknown, path: string): string | undefined {
    let estimate = 0;
    try {
        return JSON.stringify(value, (key, entry: unknown) => {
            estimate += key.length + 4;
            if (typeof entry === "string") estimate += entry.length + 2;
            else if (typeof entry !== "object" || entry === null) estimate += 24;
            if (estimate > SERIALIZE_HARD_LIMIT) {
                throw new OpaqueSerializationBound();
            }
            return entry;
        });
    } catch (error) {
        if (error instanceof OpaqueSerializationBound) {
            throw new NegotiationError("opaque_too_large", path);
        }
        throw error;
    }
}

/**
 * The function validates already-serialized data without invoking provider code.
 * Callers must encode the returned parsed snapshot.
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
    assertOpaqueLeaves(parsed, path);
    return parsed as OpaqueObject;
}

/** A lone surrogate has no required UTF-16 partner. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The validator rejects strings and object keys containing lone surrogates.
 * `JSON.stringify` escapes each lone surrogate as a `\uXXXX` sequence rather than failing.
 */
/**
 * Integral numbers outside the safe-integer range cannot represent every integer exactly.
 * Distinct integers can collapse to the same `Number`.
 */
function assertOpaqueLeaves(value: unknown, path: string): void {
    if (typeof value === "string") {
        if (LONE_SURROGATE_RE.test(value)) {
            throw new NegotiationError("invalid_type", path);
        }
        return;
    }
    if (typeof value === "number") {
        if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
            throw new NegotiationError("invalid_type", path);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) assertOpaqueLeaves(item, path);
        return;
    }
    if (typeof value === "object" && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
            if (LONE_SURROGATE_RE.test(key)) {
                throw new NegotiationError("invalid_type", path);
            }
            assertOpaqueLeaves(entry, path);
        }
    }
}

/**
 * `encodeNegotiateRequest` revalidates decoder bounds so it cannot emit out-of-contract bytes.
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
        // The validated snapshot, not the original value, reaches the wire.
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

/* */
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

/* */
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
 * Candidate bodies use module constants rather than frozen literals so a `NEGOTIATION_VERSION` bump remains compatible with their decoders.
 */
function taggedBody(op: string): Uint8Array {
    return new TextEncoder().encode(
        JSON.stringify({ op, negotiation_version: NEGOTIATION_VERSION }),
    );
}

/* */
export function activateResponseJson(): Uint8Array {
    return taggedBody(OP_TRANSPORT_ACTIVATE);
}

/* */
export function commitRequestJson(): Uint8Array {
    return taggedBody(OP_TRANSPORT_COMMIT);
}

/* */
export function commitResponseJson(): Uint8Array {
    return taggedBody(OP_TRANSPORT_COMMIT);
}
