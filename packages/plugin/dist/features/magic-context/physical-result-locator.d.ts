/**
 * Frozen physical result-locator codec.
 *
 * The strings are a persisted vocabulary — rows in
 * `embedding_measurement_corpus` already carry them — so the encoding is
 * byte-compatibility-frozen: `memory:`, `message:`, `chunk:` (compartment),
 * `commit:` (git_commit), `primer:`, `note:`.
 *
 * This is the single owner. Production measurement writes locators through it
 * and the retrieval benchmark reads them back through it, so a prefix or
 * source-mapping change cannot make one side stop matching the other's rows
 * (which would silently degrade recall/overlap metrics to zero rather than
 * fail).
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
    readonly anti_memory: "memory";
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
//# sourceMappingURL=physical-result-locator.d.ts.map