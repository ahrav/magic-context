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
import { readFileSync } from "node:fs";

export class CanonicalJsonError extends Error {}

export type CanonicalJsonFileFailure = "unreadable" | "invalid-json" | "non-canonical-bytes";

/**
 * `JSON.parse` retains only the last duplicate member; the byte comparison
 * rejects input containing duplicate members.
 * Use `onFailure` to preserve caller-specific errors.
 */
export function readCanonicalJsonFile(
    path: string,
    onFailure: (code: CanonicalJsonFileFailure) => Error,
): unknown {
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        throw onFailure("unreadable");
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw onFailure("invalid-json");
    }
    if (`${JSON.stringify(parsed, null, 2)}\n` !== text) {
        throw onFailure("non-canonical-bytes");
    }
    return parsed;
}

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
        // Index loop, not .map: map skips holes in sparse arrays and join
        // would serialize them as empty slots ("[1,,3]" — malformed JSON).
        // Indexing a hole yields undefined, which canonicalize rejects.
        const items: string[] = [];
        for (let i = 0; i < value.length; i += 1) {
            items.push(canonicalize(value[i], `${path}[${i}]`));
        }
        return `[${items.join(",")}]`;
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
