import { describe, expect, it } from "bun:test";

import { CanonicalJsonError, canonicalFingerprint, canonicalJson } from "./canonical-json";

describe("canonicalJson", () => {
    it("is independent of object key insertion order, recursively", () => {
        const a = { outer: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] };
        const b = { list: [{ x: 1, y: 2 }], outer: { a: 1, b: 2 } };
        expect(canonicalJson(a)).toBe(canonicalJson(b));
        expect(canonicalFingerprint(a)).toBe(canonicalFingerprint(b));
    });

    it("preserves array order", () => {
        expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    });

    it("sorts keys by code point, not locale", () => {
        expect(canonicalJson({ b: 1, B: 2, a: 3 })).toBe('{"B":2,"a":3,"b":1}');
    });

    it("encodes newlines and unicode through JSON escaping", () => {
        expect(canonicalJson({ s: "line1\nline2" })).toBe('{"s":"line1\\nline2"}');
    });

    it("rejects undefined fields instead of silently dropping them", () => {
        expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalJsonError);
        expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    });

    it("rejects sparse-array holes instead of emitting malformed JSON", () => {
        // [1, <hole>, 3]: Array.prototype.map skips the hole and join would
        // serialize it as an empty slot ("[1,,3]").
        const sparse = [1];
        sparse.length = 3;
        sparse[2] = 3;
        expect(() => canonicalJson(sparse)).toThrow(CanonicalJsonError);
        expect(() => canonicalJson({ a: sparse })).toThrow("$.a[1]");
        expect(() => canonicalJson([undefined])).toThrow(CanonicalJsonError);
    });

    it("rejects non-finite numbers, functions, and non-plain objects", () => {
        expect(() => canonicalJson({ n: Number.NaN })).toThrow(CanonicalJsonError);
        expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(CanonicalJsonError);
        expect(() => canonicalJson({ f: () => 1 })).toThrow(CanonicalJsonError);
        expect(() => canonicalJson(new Date())).toThrow(CanonicalJsonError);
        expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError);
    });

    it("names the offending path in rejection messages", () => {
        expect(() => canonicalJson({ a: { b: [Number.NaN] } })).toThrow("$.a.b[0]");
    });

    it("fingerprints change only with semantic content", () => {
        const base = canonicalFingerprint({ a: 1 });
        expect(canonicalFingerprint({ a: 1 })).toBe(base);
        expect(canonicalFingerprint({ a: 2 })).not.toBe(base);
    });
});
