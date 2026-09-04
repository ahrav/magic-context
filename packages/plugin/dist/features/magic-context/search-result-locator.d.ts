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
export declare const PHYSICAL_LOCATOR_KINDS: readonly ["memory", "message", "chunk", "commit", "primer", "note"];
export type PhysicalLocatorKind = (typeof PHYSICAL_LOCATOR_KINDS)[number];
/**
 * Frozen search-source -> locator-kind mapping. The single source of truth
 * for the persisted prefix vocabulary: the encoder below and every benchmark
 * alias table derive from this object, so a prefix change is a compile-time
 * break instead of silent locator-resolution drift.
 */
export declare const SOURCE_LOCATOR_KIND: {
    readonly memory: "memory";
    readonly message: "message";
    readonly compartment: "chunk";
    readonly git_commit: "commit";
    readonly primer: "primer";
    readonly note: "note";
};
export interface PhysicalResultLocator {
    kind: PhysicalLocatorKind;
    /** The kind-local identifier (row id, message id, or commit sha). */
    locator: string;
}
/** Encode a search result to its frozen physical locator string. */
export declare function encodePhysicalResultLocator(result: UnifiedSearchResult): string;
export type PhysicalLocatorParse = {
    ok: true;
    value: PhysicalResultLocator;
} | {
    ok: false;
    reason: "missing-separator" | "unknown-kind" | "empty-locator";
};
/**
 * Parse a production locator string. Failures return a deterministic reason
 * code and never echo the raw input (locator strings can embed message ids
 * and shas that diagnostics must not leak).
 */
export declare function parsePhysicalResultLocator(raw: string): PhysicalLocatorParse;
//# sourceMappingURL=search-result-locator.d.ts.map