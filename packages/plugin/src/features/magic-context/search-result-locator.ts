/**
 * Production physical result-locator codec.
 *
 * One frozen encoding for the physical identity of a `UnifiedSearchResult`,
 * shared by shadow measurement telemetry and (one-way) by the script-only
 * retrieval-benchmark layer. The strings are a persisted vocabulary — rows in
 * `embedding_measurement_corpus` already carry them — so this codec is
 * byte-compatibility-frozen: `memory:`, `message:`, `chunk:` (compartment),
 * `commit:` (git_commit), `primer:`, `note:`.
 *
 * Production code must never import benchmark contracts; the benchmark layer
 * imports THIS module and layers canonical relevance identities on top.
 */

import type { UnifiedSearchResult } from "./search";

export const PHYSICAL_LOCATOR_KINDS = [
    "memory",
    "message",
    "chunk",
    "commit",
    "primer",
    "note",
] as const;

export type PhysicalLocatorKind = (typeof PHYSICAL_LOCATOR_KINDS)[number];

export interface PhysicalResultLocator {
    kind: PhysicalLocatorKind;
    /** The kind-local identifier (row id, message id, or commit sha). */
    locator: string;
}

/** Encode a search result to its frozen physical locator string. */
export function encodePhysicalResultLocator(result: UnifiedSearchResult): string {
    switch (result.source) {
        case "memory":
            return `memory:${result.memoryId}`;
        case "message":
            return `message:${result.messageId}`;
        case "compartment":
            return `chunk:${result.compartmentId}`;
        case "git_commit":
            return `commit:${result.sha}`;
        case "primer":
            return `primer:${result.primerId}`;
        case "note":
            return `note:${result.noteId}`;
    }
}

export type PhysicalLocatorParse =
    | { ok: true; value: PhysicalResultLocator }
    | { ok: false; reason: "missing-separator" | "unknown-kind" | "empty-locator" };

/**
 * Parse a production locator string. Failures return a deterministic reason
 * code and never echo the raw input (locator strings can embed message ids
 * and shas that diagnostics must not leak).
 */
export function parsePhysicalResultLocator(raw: string): PhysicalLocatorParse {
    const separator = raw.indexOf(":");
    if (separator <= 0) return { ok: false, reason: "missing-separator" };
    const kind = raw.slice(0, separator) as PhysicalLocatorKind;
    if (!PHYSICAL_LOCATOR_KINDS.includes(kind)) return { ok: false, reason: "unknown-kind" };
    const locator = raw.slice(separator + 1);
    if (locator.length === 0) return { ok: false, reason: "empty-locator" };
    return { ok: true, value: { kind, locator } };
}
