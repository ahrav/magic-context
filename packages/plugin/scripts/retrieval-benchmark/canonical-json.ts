/**
 * Benchmark-owned canonical JSON (KTD6).
 *
 * `stableStringify` in src/shared documents itself as process-local and
 * explicitly not a cross-runtime canonical serializer, so fingerprints that
 * gate release approval get their own stricter codec instead of widening that
 * contract.
 *
 * Rules: UTF-8 encoding, recursively sorted object keys (UTF-16 code-unit
 * order — deterministic across runtimes, though it differs from code-point
 * order for astral-plane keys), preserved array order, JSON number formatting
 * restricted to finite values, and no undefined anywhere (absent fields must
 * be omitted by the caller, never carried as undefined). Strings pass through
 * JSON.stringify escaping, so newlines are always encoded as \n.
 */

import { createHash } from "node:crypto";

export class CanonicalJsonError extends Error {}

function canonicalize(value: unknown, path: string): string {
    if (value === null) return "null";
    switch (typeof value) {
        case "string":
        case "boolean":
            return JSON.stringify(value);
        case "number":
            if (!Number.isFinite(value)) {
                throw new CanonicalJsonError(`non-finite number at ${path}`);
            }
            return JSON.stringify(value);
        case "object":
            break;
        default:
            throw new CanonicalJsonError(`unsupported ${typeof value} at ${path}`);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item, i) => canonicalize(item, `${path}[${i}]`)).join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new CanonicalJsonError(`non-plain object at ${path}`);
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => {
        if (a < b) return -1;
        return a > b ? 1 : 0;
    });
    const parts: string[] = [];
    for (const [key, child] of entries) {
        if (child === undefined) {
            throw new CanonicalJsonError(`undefined field at ${path}.${key}`);
        }
        parts.push(`${JSON.stringify(key)}:${canonicalize(child, `${path}.${key}`)}`);
    }
    return `{${parts.join(",")}}`;
}

/** Serialize to the benchmark canonical JSON form. Throws on non-JSON input. */
export function canonicalJson(value: unknown): string {
    return canonicalize(value, "$");
}

/** SHA-256 hex fingerprint over the UTF-8 bytes of the canonical JSON form. */
export function canonicalFingerprint(value: unknown): string {
    return createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex");
}
