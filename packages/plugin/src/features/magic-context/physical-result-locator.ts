/**
 *
 *
 * fail).
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

/**
 */
export const SOURCE_LOCATOR_KIND = {
    memory: "memory",
    anti_memory: "memory",
    message: "message",
    compartment: "chunk",
    git_commit: "commit",
    primer: "primer",
    note: "note",
} as const satisfies Record<UnifiedSearchResult["source"], PhysicalLocatorKind>;

export interface PhysicalResultLocator {
    kind: PhysicalLocatorKind;
    /** `locator` identifies the kind-local row ID, message ID, or commit SHA. */
    locator: string;
}

/* */
export function encodePhysicalResultLocator(result: UnifiedSearchResult): string {
    switch (result.source) {
        case "memory":
        case "anti_memory":
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
