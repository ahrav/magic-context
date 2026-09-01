/**
 *
 * contract.
 *
 * Canonical JSON uses UTF-8 bytes and sorts object keys recursively by UTF-16 code-unit order.
 * Canonical JSON preserves array order and uses JSON.stringify number formatting.
 * canonicalize rejects undefined array elements and enumerable string-keyed object fields.
 * canonicalJson serializes newline characters as `\n`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export class CanonicalJsonError extends Error {}

export type CanonicalJsonFileFailure = "unreadable" | "invalid-json" | "non-canonical-bytes";

/**
 * `JSON.parse` retains only the last duplicate member; the byte comparison rejects input containing duplicate members.
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
        // The index loop visits sparse-array holes, which Array.prototype.map skips.
        // Joining mapped sparse-array values would emit empty JSON array slots such as `[1,,3]`.
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

/** canonicalJson throws CanonicalJsonError for unsupported value types, non-finite numbers, undefined array elements or enumerable string-keyed object fields, and non-plain objects. */
export function canonicalJson(value: unknown): string {
    return canonicalize(value, "$");
}

/* */
export function canonicalFingerprint(value: unknown): string {
    return createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex");
}
