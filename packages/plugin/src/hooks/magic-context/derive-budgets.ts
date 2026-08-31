/**
 * Budget derivation
 *
 *
 * The trigger budget drives size-based historian triggers (`tail_size`, `commit_clusters`).
 * The trigger budget uses the main model's usable working space rather than its total context.
 *
 * Historian chunks scale with the historian model because historian is constrained by its own context.
 */

import { getSdkContextLimit } from "../../shared/models-dev-cache";

const TRIGGER_BUDGET_PERCENTAGE = 0.05;
const TRIGGER_BUDGET_MIN = 5_000;
const TRIGGER_BUDGET_MAX = 50_000;

const HISTORIAN_CHUNK_PERCENTAGE = 0.25;
const HISTORIAN_CHUNK_MIN = 8_000;
const HISTORIAN_CHUNK_MAX = 50_000;

const DEFAULT_HISTORIAN_CONTEXT_FALLBACK = 128_000;

/**
 * Size-based historian triggers `tail_size` and `commit_clusters` use this budget.
 *
 * @param mainContextLimit Main session model's context window (tokens).
 */
export function deriveTriggerBudget(
    mainContextLimit: number,
    executeThresholdPercentage: number,
): number {
    if (!Number.isFinite(mainContextLimit) || mainContextLimit <= 0) {
        return TRIGGER_BUDGET_MIN;
    }
    const thresholdFraction = Math.max(0, executeThresholdPercentage) / 100;
    const usable = mainContextLimit * thresholdFraction;
    const derived = Math.round(usable * TRIGGER_BUDGET_PERCENTAGE);
    return Math.max(TRIGGER_BUDGET_MIN, Math.min(TRIGGER_BUDGET_MAX, derived));
}

/**
 * The historian uses the returned budget for raw-history chunks within its context window.
 *
 * @param historianContextLimit Historian model's context window (tokens).
 */
export function deriveHistorianChunkTokens(historianContextLimit: number): number {
    if (!Number.isFinite(historianContextLimit) || historianContextLimit <= 0) {
        return HISTORIAN_CHUNK_MIN;
    }
    const derived = Math.round(historianContextLimit * HISTORIAN_CHUNK_PERCENTAGE);
    return Math.max(HISTORIAN_CHUNK_MIN, Math.min(HISTORIAN_CHUNK_MAX, derived));
}

/**
 *
 * Behavior:
 * A `provider/model-id` override returns that model's positive context limit; otherwise it falls back to 128,000.
 *
 */
export function resolveHistorianContextLimit(historianModelOverride?: string): number {
    if (typeof historianModelOverride === "string" && historianModelOverride.includes("/")) {
        const [providerID, ...rest] = historianModelOverride.split("/");
        const modelID = rest.join("/");
        if (providerID && modelID) {
            const limit = getSdkContextLimit(providerID, modelID);
            if (typeof limit === "number" && limit > 0) return limit;
        }
        return DEFAULT_HISTORIAN_CONTEXT_FALLBACK;
    }

    if (typeof historianModelOverride === "string" && historianModelOverride.trim() !== "") {
        // eslint-disable-next-line no-console
        console.warn(
            `[magic-context] historian.model "${historianModelOverride}" lacks provider prefix ("provider/model-id"); using the default context limit for chunk-budget derivation.`,
        );
    }

    return DEFAULT_HISTORIAN_CONTEXT_FALLBACK;
}
