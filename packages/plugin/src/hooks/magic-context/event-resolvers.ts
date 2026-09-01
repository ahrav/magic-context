import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getOverflowState,
    loadPersistedUsage,
} from "../../features/magic-context/storage-meta-persisted";
import { escalationBands, MAX_EXECUTE_THRESHOLD } from "../../shared/escalation-bands";
import { modelRefLookupOrder, piModelRefToCanonical } from "../../shared/harness-provider-map";
import { log, sessionLog } from "../../shared/logger";
import {
    getSdkContextLimit,
    getSdkWindowGeometry,
    isSaneLimit,
} from "../../shared/models-dev-cache";
import { resolveModelConfigOrDefault } from "../../shared/prompt-surface";

export { escalationBands, MAX_EXECUTE_THRESHOLD };
export const DEFAULT_CONTEXT_LIMIT = 128_000;

export function resolveContextWindowGeometry(
    providerID: string | undefined,
    modelID: string | undefined,
    ctx?: { db?: ContextDatabase; sessionID?: string },
) {
    if (!providerID || !modelID) return undefined;
    const modelKey = resolveModelKey(providerID, modelID);
    let detected: number | undefined;
    let detectedLimitProvenance: "prompt_only" | "combined" | "unknown" = "unknown";
    if (ctx?.db && ctx.sessionID) {
        try {
            const overflow = getOverflowState(ctx.db, ctx.sessionID, modelKey);
            if (overflow.detectedContextLimit > 0) {
                detected = overflow.detectedContextLimit;
                detectedLimitProvenance = overflow.detectedContextLimitProvenance;
            }
        } catch {
            // The resolver ignores session metadata read failures and uses SDK geometry.
        }
    }
    return getSdkWindowGeometry(providerID, modelID, detected, {
        detectedLimitProvenance,
        harness: "opencode",
    });
}

type CacheTtlConfig = string | Record<string, string>;

/**
 * Best-effort read of the detected-overflow limit for a session/model; falls
 * back to "unknown" provenance when session meta is unreadable.
 */
function readDetectedLimit(
    ctx: { db?: ContextDatabase; sessionID?: string } | undefined,
    modelKey: string | undefined,
): { detected?: number; provenance: "prompt_only" | "combined" | "unknown" } {
    if (ctx?.db && ctx.sessionID) {
        try {
            const overflow = getOverflowState(ctx.db, ctx.sessionID, modelKey);
            if (overflow.detectedContextLimit > 0) {
                return {
                    detected: overflow.detectedContextLimit,
                    provenance: overflow.detectedContextLimitProvenance,
                };
            }
        } catch {
            // Reading session meta is best-effort — fall through to the catalog.
        }
    }
    return { provenance: "unknown" };
}

/**
 * Resolve the effective context limit for a provider/model pair. By default
 * this returns the output-reserved safe input budget. `reservation: "none"`
 * preserves the same catalog, detected-limit, and fallback resolution while
 * exposing the unreserved window for native-usage display metrics only.
 */

export function resolveContextLimit(
    providerID: string | undefined,
    modelID: string | undefined,
    ctx?: {
        db?: ContextDatabase;
        sessionID?: string;
        reservation?: "default" | "none";
    },
): number {
    const modelKey = resolveModelKey(providerID, modelID);
    const { detected, provenance: detectedLimitProvenance } = readDetectedLimit(ctx, modelKey);

    // Combined and unknown detections narrow the raw context before output reservation.
    // Prompt-only detections enter the pre-carved input arm.
    const fromModelsDev =
        providerID && modelID
            ? getSdkContextLimit(providerID, modelID, detected, {
                  reservation: ctx?.reservation,
                  detectedLimitProvenance,
              })
            : undefined;
    return fromModelsDev ?? detected ?? DEFAULT_CONTEXT_LIMIT;
}

/**
 * resolveTrustedContextLimit does not return the generic 128K `DEFAULT_CONTEXT_LIMIT`.
 *
 * Trusted limits include models.dev entries and user provider overrides.
 * A detected-overflow limit is trusted when it is smaller than the models.dev limit.
 * A detected-overflow limit is trusted when models.dev has no entry.
 * A persisted usage-reported limit is trusted only when models.dev and overflow detection are unavailable.
 * The persisted usage-reported limit is trusted only when its observed model key matches the current model key.
 *
 * For unknown models, history budgeting uses live usage instead of `DEFAULT_CONTEXT_LIMIT` so a 128K fallback cannot undersize large-context histories.
 * The budget resolver trusts model limits, detected limits, and model-matched usage-reported limits; otherwise it uses live usage.
 * resolveContextLimit returns `DEFAULT_CONTEXT_LIMIT` for pressure math because its denominator must be positive.
 */
export function resolveTrustedContextLimit(
    providerID: string | undefined,
    modelID: string | undefined,
    ctx?: { db?: ContextDatabase; sessionID?: string },
): number | undefined {
    const modelKey = resolveModelKey(providerID, modelID);
    const { detected, provenance: detectedLimitProvenance } = readDetectedLimit(ctx, modelKey);

    // The resolver applies combined detections before output reservation and prompt-only detections to the pre-carved input budget.
    // Comparing a combined detection with an already-reserved budget would reserve output twice.
    // A prompt-only detection must not reserve output again.
    const fromModelsDev =
        providerID && modelID
            ? getSdkContextLimit(providerID, modelID, detected, {
                  detectedLimitProvenance,
              })
            : undefined;
    if (typeof fromModelsDev === "number" && fromModelsDev > 0) return fromModelsDev;
    if (detected !== undefined) return detected;

    // Usage reports are trusted only for the model that produced them.
    // session-scoped limit from a previous model must not leak across a switch.
    if (modelKey && ctx?.db && ctx.sessionID) {
        try {
            const persisted = loadPersistedUsage(ctx.db, ctx.sessionID);
            if (
                persisted !== null &&
                piModelRefToCanonical(persisted.lastObservedModelKey ?? "") ===
                    piModelRefToCanonical(modelKey) &&
                isSaneLimit(persisted.lastUsageContextLimit)
            ) {
                return persisted.lastUsageContextLimit;
            }
        } catch {
            // best-effort; ignore
        }
    }

    return undefined;
}

export function resolveCacheTtl(cacheTtl: CacheTtlConfig, modelKey: string | undefined): string {
    if (typeof cacheTtl === "string") {
        return cacheTtl;
    }

    return resolveModelConfigOrDefault(cacheTtl, modelKey, cacheTtl.default ?? "5m");
}

type ExecuteThresholdConfig = number | { default: number; [modelKey: string]: number };
type ExecuteThresholdTokensConfig =
    | { default?: number; [modelKey: string]: number | undefined }
    | undefined;

export interface ExecuteThresholdOptions {
    /** `tokensConfig` overrides the percentage-based threshold when it matches `modelKey` and `context_limit` is valid.
     * */
    tokensConfig?: ExecuteThresholdTokensConfig;
    /** `context_limit` is required with `tokensConfig` to convert tokens to a percentage.
     * `context_limit` caps the execute threshold at 90% of the context limit. */
    contextLimit?: number;
    /** `sessionID` directs clamping warnings to the session log; absent IDs use the global log. */
    sessionId?: string;
}

export type ExecuteThresholdMode = "percentage" | "tokens";

export interface ExecuteThresholdDetail {
    /** Downstream calculations use the effective execute threshold, constrained to 0–90%. */
    percentage: number;
    /** The authoritative source is tokens config when its modelKey matches and context is valid; otherwise it is percentage. */
    mode: ExecuteThresholdMode;
    /** In `tokens` mode, the value is the absolute token value clamped to 90% × `contextLimit`. */
    absoluteTokens?: number;
    /** The returned source key is the matched config key, or `"default"` when the default fallback applies. */
    matchedKey?: string;
    /**
     * The returned clamping flag is true when the configured value exceeds the safe cap and is reduced.
     * In tokens mode, clamping occurs when configured tokens exceed 90% × `contextLimit`.
     * In percentage mode, clamping occurs when the configured percentage exceeds `MAX_EXECUTE_THRESHOLD` (90).
     * `clamped` reports that the configured value was reduced.
     * `clamped` is present only when a clamp occurred; otherwise it is absent.
     */
    clamped?: boolean;
    /**
     * `configuredValue` is the raw configured token count in tokens mode or percentage in percentage mode.
     * `configuredValue` is present only when `clamped` is `true`.
     */
    configuredValue?: number;
}

// Clamp-warning deduplication is scoped by the session ID, model key, configured token value, and cap, with sentinels for missing session IDs and model keys.
const clampWarnSeen = new Set<string>();

/**
 */
function isFinitePositive(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * `modelKeyLookupOrder` yields progressively less-specific lookup keys for each model key.
 *
 * Derived model IDs may append `-`-delimited segments to a base model ID.
 * For example, `gpt-5.4-fast` derives from base model `gpt-5.4`.
 * `modelKeyLookupOrder` returns keys from most to least specific so resolution selects the most specific match.
 *
 *   "openai/gpt-5.4-fast"  (exact)
 */
function* modelKeyLookupOrder(modelKey: string): Generator<string> {
    const slash = modelKey.indexOf("/");
    const providerRefs = slash >= 0 ? modelRefLookupOrder(modelKey) : [];
    let modelId = slash >= 0 ? modelKey.slice(slash + 1) : modelKey;

    while (modelId.length > 0) {
        for (const providerRef of providerRefs) {
            const providerSlash = providerRef.indexOf("/");
            yield `${providerRef.slice(0, providerSlash)}/${modelId}`;
        }
        yield modelId;
        const lastDash = modelId.lastIndexOf("-");
        if (lastDash <= 0) break;
        modelId = modelId.slice(0, lastDash);
    }
}

/**
 * `resolveExecuteThresholdDetail` returns the effective percentage and authoritative config source.
 * Callers that need only the percentage can use `resolveExecuteThreshold`.
 * Callers that display `mode` must use `resolveExecuteThresholdDetail`.
 */
export function resolveExecuteThresholdDetail(
    config: ExecuteThresholdConfig,
    modelKey: string | undefined,
    fallback: number,
    options?: ExecuteThresholdOptions,
): ExecuteThresholdDetail {
    // Tokens-based resolution takes precedence for a matching token configuration with a finite positive `contextLimit`.
    // Non-finite or non-positive token values and context limits fall through to percentage resolution.
    if (options?.tokensConfig && isFinitePositive(options.contextLimit)) {
        const contextLimit = options.contextLimit;
        const tokenMatch = resolveTokensMatchWithKey(options.tokensConfig, modelKey);
        if (tokenMatch && isFinitePositive(tokenMatch.value)) {
            const cap = contextLimit * (MAX_EXECUTE_THRESHOLD / 100);
            const effectiveTokens = Math.min(tokenMatch.value, cap);
            if (effectiveTokens < tokenMatch.value) {
                const dedupeKey = `${options.sessionId ?? "__global__"}|${modelKey ?? "__default__"}|${tokenMatch.value}|${cap}`;
                if (!clampWarnSeen.has(dedupeKey)) {
                    clampWarnSeen.add(dedupeKey);
                    const msg = `execute_threshold_tokens clamped: ${tokenMatch.value} → ${effectiveTokens} (${MAX_EXECUTE_THRESHOLD}% of ${contextLimit}) for ${modelKey ?? "default"}`;
                    if (options.sessionId) {
                        sessionLog(options.sessionId, `WARN: ${msg}`);
                    } else {
                        log(`[magic-context] WARN: ${msg}`);
                    }
                }
            }
            const percentage = (effectiveTokens / contextLimit) * 100;
            const detail: ExecuteThresholdDetail = {
                percentage: Math.min(percentage, MAX_EXECUTE_THRESHOLD),
                mode: "tokens",
                absoluteTokens: Math.floor(effectiveTokens),
                matchedKey: tokenMatch.matchedKey,
            };
            // `configuredValue` retains `tokenMatch.value` when clamping.
            if (effectiveTokens < tokenMatch.value) {
                detail.clamped = true;
                detail.configuredValue = tokenMatch.value;
            }
            return detail;
        }
    }

    let resolved: number;
    let matchedKey: string | undefined;

    if (typeof config === "number") {
        resolved = config;
    } else if (modelKey) {
        let matched: number | undefined;
        for (const candidate of modelKeyLookupOrder(modelKey)) {
            if (typeof config[candidate] === "number") {
                matched = config[candidate];
                matchedKey = candidate;
                break;
            }
        }
        if (matched === undefined && typeof config.default === "number") {
            resolved = config.default;
            matchedKey = "default";
        } else {
            resolved = matched ?? fallback;
        }
    } else if (typeof config.default === "number") {
        resolved = config.default;
        matchedKey = "default";
    } else {
        resolved = fallback;
    }

    if (!Number.isFinite(resolved) || resolved < 0) {
        resolved = fallback;
    }

    const cappedPercentage = Math.min(resolved, MAX_EXECUTE_THRESHOLD);
    const percentageClamped = cappedPercentage < resolved;
    if (percentageClamped) {
        const dedupeKey = `pct|${options?.sessionId ?? "__global__"}|${modelKey ?? "__default__"}|${resolved}`;
        if (!clampWarnSeen.has(dedupeKey)) {
            clampWarnSeen.add(dedupeKey);
            const msg = `execute_threshold clamped ${resolved}% → ${MAX_EXECUTE_THRESHOLD}% for ${modelKey ?? "default"} (capped against the output-reserved safe window; 10% remains for mid-turn growth before the absolute 95% wall)`;
            if (options?.sessionId) {
                sessionLog(options.sessionId, `WARN: ${msg}`);
            } else {
                log(`[magic-context] WARN: ${msg}`);
            }
        }
    }
    const detail: ExecuteThresholdDetail = {
        percentage: cappedPercentage,
        mode: "percentage",
        matchedKey,
    };
    // `configuredValue` retains the unclamped configured percentage.
    if (percentageClamped) {
        detail.clamped = true;
        detail.configuredValue = resolved;
    }
    return detail;
}

/**
 * Callers needing `mode` or `absoluteTokens` must use `resolveExecuteThresholdDetail`.
 */
export function resolveExecuteThreshold(
    config: ExecuteThresholdConfig,
    modelKey: string | undefined,
    fallback: number,
    options?: ExecuteThresholdOptions,
): number {
    return resolveExecuteThresholdDetail(config, modelKey, fallback, options).percentage;
}

function resolveTokensMatchWithKey(
    tokensConfig: ExecuteThresholdTokensConfig,
    modelKey: string | undefined,
): { value: number; matchedKey: string } | undefined {
    if (!tokensConfig) {
        return undefined;
    }

    if (modelKey) {
        for (const candidate of modelKeyLookupOrder(modelKey)) {
            const value = tokensConfig[candidate];
            if (typeof value === "number") {
                return { value, matchedKey: candidate };
            }
        }
    }

    if (typeof tokensConfig.default === "number") {
        return { value: tokensConfig.default, matchedKey: "default" };
    }

    return undefined;
}

export function resolveModelKey(
    providerID: string | undefined,
    modelID: string | undefined,
): string | undefined {
    if (!providerID || !modelID) {
        return undefined;
    }

    return piModelRefToCanonical(`${providerID}/${modelID}`);
}

export function resolveSessionId(
    properties: { info?: unknown; sessionID?: string } | undefined,
): string | undefined {
    if (typeof properties?.sessionID === "string") {
        return properties.sessionID;
    }

    const info = properties?.info;
    if (info === null || typeof info !== "object") {
        return undefined;
    }

    const record = info as Record<string, unknown>;
    if (typeof record.sessionID === "string") {
        return record.sessionID;
    }
    if (typeof record.id === "string") {
        return record.id;
    }

    return undefined;
}
