import type { ContextDatabase } from "../../features/magic-context/storage";
import { escalationBands, MAX_EXECUTE_THRESHOLD } from "../../shared/escalation-bands";
export { escalationBands, MAX_EXECUTE_THRESHOLD };
export declare const DEFAULT_CONTEXT_LIMIT = 128000;
export declare function resolveContextWindowGeometry(providerID: string | undefined, modelID: string | undefined, ctx?: {
    db?: ContextDatabase;
    sessionID?: string;
}): import("../../shared/window-geometry").WindowGeometryResult | undefined;
type CacheTtlConfig = string | Record<string, string>;
/**
 * Resolve the effective context limit for a provider/model pair. By default
 * this returns the output-reserved safe input budget. `reservation: "none"`
 * preserves the same catalog, detected-limit, and fallback resolution while
 * exposing the unreserved window for native-usage display metrics only.
 */
export declare function resolveContextLimit(providerID: string | undefined, modelID: string | undefined, ctx?: {
    db?: ContextDatabase;
    sessionID?: string;
    reservation?: "default" | "none";
}): number;
/**
 * Like resolveContextLimit, but returns a limit ONLY when it is TRUSTED for the
 * current model, rather than the generic 128K `DEFAULT_CONTEXT_LIMIT`.
 *
 * Resolution precedence is:
 *   1. models.dev or a user provider override.
 *   2. A detected-overflow limit when it is smaller than the models.dev limit,
 *      or whenever models.dev has no entry.
 *   3. A sane persisted usage-reported limit when models.dev and overflow
 *      detection are both unavailable, but only when its observed model key
 *      matches the current model key.
 *
 * The history-budget resolver needs this distinction: deriving the decay budget
 * from a bare 128K guess for an UNKNOWN model would shrink history below what
 * the live-usage back-derivation would yield for a large-context model. So the
 * budget resolver only trusts a real, detected, or model-matched usage-reported
 * limit and otherwise falls back to live-usage. (resolveContextLimit itself must
 * keep returning 128K for pressure math, which needs a positive denominator.)
 */
export declare function resolveTrustedContextLimit(providerID: string | undefined, modelID: string | undefined, ctx?: {
    db?: ContextDatabase;
    sessionID?: string;
}): number | undefined;
export declare function resolveCacheTtl(cacheTtl: CacheTtlConfig, modelKey: string | undefined): string;
type ExecuteThresholdConfig = number | {
    default: number;
    [modelKey: string]: number;
};
type ExecuteThresholdTokensConfig = {
    default?: number;
    [modelKey: string]: number | undefined;
} | undefined;
export interface ExecuteThresholdOptions {
    /** Optional tokens-based threshold config. When matched for the given modelKey,
     *  overrides the percentage-based threshold. */
    tokensConfig?: ExecuteThresholdTokensConfig;
    /** Required when `tokensConfig` is provided — used to convert tokens → percentage
     *  and to clamp values above 90% × context_limit. */
    contextLimit?: number;
    /** Session ID for warn logs when clamping. If absent, warns to global log. */
    sessionId?: string;
}
export type ExecuteThresholdMode = "percentage" | "tokens";
export interface ExecuteThresholdDetail {
    /** Effective execute threshold as a percentage (0–90). Downstream math keys off this. */
    percentage: number;
    /** Which source was authoritative: tokens config (when matched + valid context) or percentage. */
    mode: ExecuteThresholdMode;
    /** When mode is "tokens", the absolute token value after clamping (≤ 90% × contextLimit). */
    absoluteTokens?: number;
    /** The config key that matched, if any (for display/debugging). `"default"` when default fallback. */
    matchedKey?: string;
    /**
     * True when the user's configured value exceeded the safe cap and was reduced.
     * Tokens mode: configured tokens > 90% × contextLimit. Percentage mode:
     * configured percentage > MAX_EXECUTE_THRESHOLD (90). Display surfaces read this
     * to tell the user their value was clamped instead of silently ignoring it (#241).
     * Only present (true) when a clamp actually happened; absent otherwise.
     */
    clamped?: boolean;
    /**
     * The raw configured value before clamping — a token count in tokens mode, a
     * percentage in percentage mode. Populated only alongside `clamped` so display
     * surfaces can show the math (e.g. "190,000 > 90% of 128,000").
     */
    configuredValue?: number;
}
/**
 * Single source of truth for execute-threshold resolution. Returns the effective
 * percentage plus which config source was authoritative. Callers that only need
 * the percentage can use `resolveExecuteThreshold` (thin wrapper below); callers
 * that surface the mode to users (`/ctx-status`, TUI, RPC) must use this directly
 * to avoid the "progressive lookup drift" bug where two call sites disagree on
 * whether tokens mode is active.
 */
export declare function resolveExecuteThresholdDetail(config: ExecuteThresholdConfig, modelKey: string | undefined, fallback: number, options?: ExecuteThresholdOptions): ExecuteThresholdDetail;
/**
 * Backward-compatible wrapper around `resolveExecuteThresholdDetail`.
 * Use the detail version when you also need the mode or absolute token value.
 */
export declare function resolveExecuteThreshold(config: ExecuteThresholdConfig, modelKey: string | undefined, fallback: number, options?: ExecuteThresholdOptions): number;
export declare function resolveModelKey(providerID: string | undefined, modelID: string | undefined): string | undefined;
export declare function resolveSessionId(properties: {
    info?: unknown;
    sessionID?: string;
} | undefined): string | undefined;
//# sourceMappingURL=event-resolvers.d.ts.map