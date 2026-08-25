/**
 * Frozen physical result-locator codec for the benchmark layer. The strings
 * are a persisted vocabulary — rows in `embedding_measurement_corpus` already
 * carry them — so the encoding is byte-compatibility-frozen: `memory:`,
 * `message:`, `chunk:` (compartment), `commit:` (git_commit), `primer:`,
 * `note:`. Production search-measurement keeps its own encoder for the same
 * vocabulary and never imports this layer.
 */

import type { UnifiedSearchResult } from "../../src/features/magic-context/search";

export const PHYSICAL_LOCATOR_KINDS = [
    "memory",
    "message",
    "chunk",
    "commit",
    "primer",
    "note",
] as const;

export type PhysicalLocatorKind = (typeof PHYSICAL_LOCATOR_KINDS)[number];

/**
 * Frozen search-source -> locator-kind mapping. The single source of truth
 * for the persisted prefix vocabulary: the encoder below and every benchmark
 * alias table derive from this object, so a prefix change is a compile-time
 * break instead of silent locator-resolution drift.
 */
export const SOURCE_LOCATOR_KIND = {
    memory: "memory",
    message: "message",
    compartment: "chunk",
    git_commit: "commit",
    primer: "primer",
    note: "note",
} as const satisfies Record<UnifiedSearchResult["source"], PhysicalLocatorKind>;

export interface PhysicalResultLocator {
    kind: PhysicalLocatorKind;
    /** The kind-local identifier (row id, message id, or commit sha). */
    locator: string;
}

/** Encode a search result to its frozen physical locator string. */
export function encodePhysicalResultLocator(result: UnifiedSearchResult): string {
    switch (result.source) {
        case "memory":
            return `${SOURCE_LOCATOR_KIND.memory}:${result.publicClaimId}`;
        case "message":
            return `${SOURCE_LOCATOR_KIND.message}:${result.messageId}`;
        case "compartment":
            return `${SOURCE_LOCATOR_KIND.compartment}:${result.compartmentId}`;
        case "git_commit":
            return `${SOURCE_LOCATOR_KIND.git_commit}:${result.sha}`;
        case "primer":
            return `${SOURCE_LOCATOR_KIND.primer}:${result.primerId}`;
        case "note":
            return `${SOURCE_LOCATOR_KIND.note}:${result.noteId}`;
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
