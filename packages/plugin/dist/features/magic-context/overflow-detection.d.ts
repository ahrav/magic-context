import type { ContextLimitProvenance } from "../../shared/context-limit-provenance";
/**
 * Provider-agnostic context-overflow error detection.
 *
 * When a provider rejects a request because the prompt exceeds its context
 * window, we want to react:
 *   1. Trigger emergency recovery (historian + aggressive drops) so the next
 *      turn fits.
 *   2. If the error message reveals the real context limit, persist it as a
 *      session-specific override so pressure math is accurate going forward.
 *
 * Pattern list adapted from OpenCode's `packages/opencode/src/provider/error.ts`
 * (BSD-licensed). We keep our own copy rather than importing OpenCode internals
 * so the plugin stays decoupled from OpenCode versioning.
 *
 * References:
 *   - OpenCode overflow detection (origin of patterns):
 *     https://github.com/sst/opencode/blob/main/packages/opencode/src/provider/error.ts
 *   - Adapted originally from:
 *     https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/utils/overflow.ts
 */
/**
 * Regexes that match provider-reported context-overflow errors. Keep in sync
 * with upstream OpenCode patterns — new providers can be added here as they
 * emerge.
 */
export declare const OVERFLOW_PATTERNS: ReadonlyArray<RegExp>;
export interface ReportedContextLimit {
    value: number;
    provenance: ContextLimitProvenance;
}
export interface OverflowDetection {
    /** True if the error message matches a known overflow pattern. */
    isOverflow: boolean;
    /** Reported context limit in tokens, if extractable from the message. */
    reportedLimit?: number;
    /** Whether the number is a prompt-only ceiling or a combined context window. */
    reportedLimitProvenance?: ContextLimitProvenance;
    /** The pattern that matched, useful for logging/diagnostics. */
    matchedPattern?: string;
}
/**
 * Extract an error message from any reasonable shape. Events from OpenCode can
 * deliver errors as strings, Error instances, or plain objects with `message`.
 */
export declare function extractErrorMessage(error: unknown): string;
/**
 * Detect whether an error represents a provider-side context-overflow
 * rejection, and optionally extract the reported limit.
 */
export declare function detectOverflow(error: unknown): OverflowDetection;
/**
 * Extract the reported context-limit (in tokens) from an error message if one
 * of the known patterns matches. Returns undefined when no plausible number
 * can be extracted. Guards against false matches via plausibility clamp.
 */
export declare function parseReportedLimit(message: string): ReportedContextLimit | undefined;
//# sourceMappingURL=overflow-detection.d.ts.map