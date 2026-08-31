/**
 * OpenCode sessions resolve per-model limits only through OpenCode's SDK.
 *
 * Use `client.config.providers()` to resolve OpenCode session limits.
 * Avoid direct reads of `models.json`; a concurrent write can expose partial data.
 *
 * Layers:
 * Warm `apiCache` once at startup from the SDK.
 * Seed `apiCache` from persisted values so restarts retain limits before SDK warming completes.
 *
 * Clamp cached values to [20,000, 3,000,000] before returning or persisting them.
 * Retry startup warming when OpenCode's provider service is unavailable.
 *
 * Pi resolves its limit through `ctx.getModel().contextWindow`, not `getSdkContextLimit()`.
 * `getSdkContextLimit()` returns `undefined` for Pi.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextLimitProvenance } from "./context-limit-provenance";
import { getMagicContextStorageDir } from "./data-path";
import { getHarness } from "./harness";
import { modelRefLookupOrder } from "./harness-provider-map";
import { sessionLog } from "./logger";
import { shouldEnforcePrivateStoragePermissions } from "./storage-permissions";
import {
    deriveWindowGeometry,
    getWindowOverlay,
    resolveWindowOverlayFacts,
    type WindowGeometryResult,
} from "./window-geometry";

interface OpencodeClientLike {
    config: {
        providers: () => Promise<{ data?: { providers?: unknown } }>;
    };
}

// Reject out-of-range catalog limits; `detectedContextLimit` handles lower observed limits.
export const MIN_SANE_LIMIT = 20_000;
export const MAX_SANE_LIMIT = 3_000_000;

/** `isSaneLimit` rejects torn and unconfigured-default values from both harnesses.
 * Export `isSaneLimit` so Pi and OpenCode reject the same values. */
export function isSaneLimit(limit: number | undefined): limit is number {
    return typeof limit === "number" && limit >= MIN_SANE_LIMIT && limit <= MAX_SANE_LIMIT;
}

export type OutputReserveConfig = number | { default: number; [modelKey: string]: number };

export interface ModelLimit {
    context?: number;
    input?: number;
    output?: number;
}

interface CachedModelMetadata {
    /** Legacy resolved value, retained so pre-upgrade persisted caches remain readable. */
    limit?: number;
    /** Raw combined context window. Reservation is applied only when the value is read. */
    contextLimit?: number;
    /** Provider-enforced prompt cap. Undefined when only a combined context window is known. */
    inputLimit?: number;
    /** Maximum generated tokens advertised by the provider/model catalog. */
    outputLimit?: number;
    /** Provider metadata says the model accepts image input. Unknown is false. */
    vision?: boolean;
}

// Only allowlisted providers use separate output quotas.
// Unknown providers reserve output capacity to avoid shared-window rejections.
const SEPARATE_OUTPUT_QUOTA_PROVIDERS = new Set(["google", "google-antigravity"]);
const MIN_PLAUSIBLE_CONTEXT_LIMIT = 1024;
const OUTPUT_RESERVE_CAP_RATIO = 0.25;
let outputReserveConfig: OutputReserveConfig | undefined;
const reserveClampLogSeen = new Set<string>();

/**
 * `apiCache` is populated asynchronously from OpenCode's SDK.
 * `client.config.providers()` is the resolved OpenCode configuration source.
 * Ignore persisted values after `apiCache` has SDK data.
 * Pi does not populate apiCache because it resolves limits from contextWindow; it falls through to the file fallback.
 */
let apiCache: Map<string, CachedModelMetadata> | null = null;
let apiLoadedAt = 0;

// The persisted OpenCode apiCache survives restarts, so cold starts use limits before SDK warm-up.
// Only OpenCode warms and persists apiCache; Pi does not seed it.
let persistSeedLoaded = false;

function persistFilePath(): string {
    return join(getMagicContextStorageDir(), `model-context-limits-${getHarness()}.json`);
}

/** Seeding before SDK warm-up preserves last-known-good limits across restarts.
 * Invalid persisted metadata is discarded before it enters apiCache.
 * */
function loadPersistedApiCacheOnce(): void {
    if (persistSeedLoaded || apiCache !== null) return;
    persistSeedLoaded = true;
    try {
        const raw = readFileSync(persistFilePath(), "utf-8");
        const obj = JSON.parse(raw) as Record<
            string,
            | number
            | {
                  limit?: number;
                  contextLimit?: number;
                  inputLimit?: number;
                  outputLimit?: number;
                  vision?: boolean;
              }
        >;
        const map = new Map<string, CachedModelMetadata>();
        for (const [key, persisted] of Object.entries(obj)) {
            const limit = typeof persisted === "number" ? persisted : persisted.limit;
            const contextLimit = typeof persisted === "number" ? undefined : persisted.contextLimit;
            const inputLimit = typeof persisted === "number" ? undefined : persisted.inputLimit;
            const outputLimit = typeof persisted === "number" ? undefined : persisted.outputLimit;
            const vision = typeof persisted === "number" ? false : persisted.vision === true;
            if (isSaneLimit(contextLimit) || isSaneLimit(limit)) {
                map.set(key, {
                    limit: isSaneLimit(limit) ? limit : undefined,
                    contextLimit: isSaneLimit(contextLimit) ? contextLimit : undefined,
                    inputLimit: isSaneLimit(inputLimit) ? inputLimit : undefined,
                    outputLimit: isFinitePositive(outputLimit) ? outputLimit : undefined,
                    vision,
                });
            }
        }
        if (map.size > 0) {
            apiCache = map;
            sessionLog(
                "global",
                `models-dev-cache: seeded ${map.size} entries from persisted cache (cold start)`,
            );
        }
    } catch {
        // Persisted-cache read failures leave apiCache unset.
    }
}

/** Temp-write and rename prevent readers from observing a torn file.
 * */
function persistApiCache(): void {
    if (!apiCache) return;
    const obj: Record<string, CachedModelMetadata> = {};
    for (const [key, value] of apiCache) {
        if (isSaneLimit(value.limit)) {
            obj[key] = {
                limit: value.limit,
                contextLimit: isSaneLimit(value.contextLimit) ? value.contextLimit : undefined,
                inputLimit: isSaneLimit(value.inputLimit) ? value.inputLimit : undefined,
                outputLimit: isFinitePositive(value.outputLimit) ? value.outputLimit : undefined,
                vision: value.vision === true,
            };
        }
    }
    try {
        const dir = getMagicContextStorageDir();
        mkdirSync(dir, { recursive: true });
        const target = persistFilePath();
        const tmp = `${target}.${process.pid}.tmp`;
        if (shouldEnforcePrivateStoragePermissions()) {
            writeFileSync(tmp, JSON.stringify(obj), { encoding: "utf-8", mode: 0o600 });
        } else {
            writeFileSync(tmp, JSON.stringify(obj), { encoding: "utf-8" });
        }
        renameSync(tmp, target);
    } catch {
        // A failed persist loses only cold-start cache warmth, not correctness.
    }
}

function isFinitePositive(value: number | undefined): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function modelKeyLookupOrder(providerID: string, modelID: string): string[] {
    const candidates = [...modelRefLookupOrder(`${providerID}/${modelID}`), modelID];
    const colon = modelID.lastIndexOf(":");
    if (colon > 0) {
        const bareModel = modelID.slice(0, colon);
        candidates.push(...modelRefLookupOrder(`${providerID}/${bareModel}`), bareModel);
    }
    return [...new Set(candidates)];
}

/* */
export function resolveOutputReserve(
    providerID: string,
    modelID: string,
    config: OutputReserveConfig | undefined = outputReserveConfig,
): number | undefined {
    if (typeof config === "number")
        return Number.isFinite(config) && config >= 0 ? config : undefined;
    if (!config) return undefined;
    for (const candidate of modelKeyLookupOrder(providerID, modelID)) {
        const value = config[candidate];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    }
    return Number.isFinite(config.default) && config.default >= 0 ? config.default : undefined;
}

function logReserveClampOnce(key: string, message: string): void {
    if (reserveClampLogSeen.has(key)) return;
    reserveClampLogSeen.add(key);
    sessionLog("global", `models-dev-cache: ${message}`);
}

/** Set the user-tier reservation override shared by every resolved-limit consumer. */
export function setOutputReserveConfig(config: OutputReserveConfig | undefined): void {
    outputReserveConfig = config;
}

/**
 *
 * A smaller input cap takes precedence unchanged.
 * Providers outside the separate-output-quota allowlist reserve generated tokens from the shared context window by default.
 * The allowlisted APIs use a separate output quota.
 * output_reserve = 0 disables output-token reservation; other values override the provider default.
 * Reservation leaves at least half the raw context window and at least 1024 tokens.
 */
export function resolveLimit(
    limit: ModelLimit | undefined,
    providerID: string,
    modelID: string,
    reserveConfig: OutputReserveConfig | undefined = outputReserveConfig,
): number | undefined {
    if (!limit) return undefined;
    const context = isFinitePositive(limit.context) ? limit.context : undefined;
    const input = isFinitePositive(limit.input) ? limit.input : undefined;
    if (input !== undefined && (context === undefined || input < context)) return input;
    if (context === undefined) return undefined;

    const configuredReserve = resolveOutputReserve(providerID, modelID, reserveConfig);
    let reserve: number;
    if (configuredReserve !== undefined) {
        reserve = configuredReserve;
    } else if (SEPARATE_OUTPUT_QUOTA_PROVIDERS.has(providerID)) {
        reserve = 0;
    } else {
        const output = isFinitePositive(limit.output) ? limit.output : 0;
        const cap = context * OUTPUT_RESERVE_CAP_RATIO;
        reserve = Math.min(output, cap);
        if (output > cap) {
            logReserveClampOnce(
                `cap|${providerID}/${modelID}|${context}|${output}`,
                `output reserve capped at 25% for ${providerID}/${modelID}: ${output} → ${cap}`,
            );
        }
    }

    const floor = Math.max(MIN_PLAUSIBLE_CONTEXT_LIMIT, context * 0.5);
    const maxReserve = Math.max(0, context - floor);
    if (reserve > maxReserve) {
        logReserveClampOnce(
            `floor|${providerID}/${modelID}|${context}|${reserve}`,
            `output reserve clamped for ${providerID}/${modelID}: ${reserve} → ${maxReserve} (usable floor ${floor})`,
        );
        reserve = maxReserve;
    }
    return Math.floor(context - reserve);
}

function setCachedModelMetadata(
    cache: Map<string, CachedModelMetadata>,
    key: string,
    model:
        | {
              limit?: ModelLimit;
              experimental?: { modes?: Record<string, unknown> };
              capabilities?: unknown;
              modalities?: unknown;
              input?: unknown;
              attachment?: unknown;
          }
        | undefined,
): void {
    const contextLimit = model?.limit?.context;
    const inputLimit = model?.limit?.input;
    const outputLimit = model?.limit?.output;
    const rawLimit = isSaneLimit(contextLimit)
        ? contextLimit
        : isSaneLimit(inputLimit)
          ? inputLimit
          : undefined;

    // Raw-metadata validation precedes reservation so a valid raw limit remains cacheable after output reservation.
    if (rawLimit === undefined) return;

    const values = [model?.capabilities, model?.modalities, model?.input, model?.attachment];
    const vision = values.some(
        (value) =>
            JSON.stringify(value ?? "")
                .toLowerCase()
                .includes("image") ||
            JSON.stringify(value ?? "")
                .toLowerCase()
                .includes("vision"),
    );
    const value: CachedModelMetadata = {
        // The sane raw limit remains the fallback when no reserved limit is usable.
        // The resolver resolves context, input, and output limits at use time so user overrides remain live.
        limit: rawLimit,
        contextLimit: isSaneLimit(contextLimit) ? contextLimit : undefined,
        inputLimit: isSaneLimit(inputLimit) ? inputLimit : undefined,
        outputLimit: isFinitePositive(outputLimit) ? outputLimit : undefined,
        vision,
    };
    cache.set(key, value);

    // OpenCode creates derived model IDs from experimental.modes
    // Derived IDs such as gpt-5.4-fast inherit their parent model's context limit.
    const modes = model?.experimental?.modes;
    if (modes && typeof modes === "object") {
        for (const mode of Object.keys(modes)) {
            cache.set(`${key}-${mode}`, value);
        }
    }
}

/**
 *
 * Plugin startup and authentication recovery refresh model metadata.
 * The provider endpoint supplies resolved model metadata.
 *
 * The loader retries empty provider responses so startup can populate the limit cache.
 * At startup, `config.providers()` can return no providers.
 *
 */
export async function refreshModelLimitsFromApi(
    client: OpencodeClientLike,
    options?: { retries?: number; retryDelayMs?: number },
): Promise<void> {
    const attempts = Math.max(1, (options?.retries ?? 0) + 1);
    const delayMs = options?.retryDelayMs ?? 1000;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const ok = await refreshModelLimitsOnce(client);
        if (ok) return;
        if (attempt < attempts) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}

let authRewarmDone = false;

/**
 * After a successful warm, `authRewarmDone` prevents further `config.providers()` calls until reset.
 *
 * Authentication-specific limits can differ from unauthenticated catalog limits.
 * The startup cache can contain unauthenticated limits.
 *
 * `authRewarmDone` is set before the await to suppress concurrent refreshes.
 * A failed refresh clears `authRewarmDone` so a later call can retry.
 */
export async function refreshModelLimitsAfterAuthOnce(client: OpencodeClientLike): Promise<void> {
    if (authRewarmDone) return;
    authRewarmDone = true;
    const ok = await refreshModelLimitsOnce(client);
    if (!ok) authRewarmDone = false;
}

/* */
export function resetAuthRewarmLatchForTest(): void {
    authRewarmDone = false;
}

/* */
async function refreshModelLimitsOnce(client: OpencodeClientLike): Promise<boolean> {
    try {
        const result = await client.config.providers();
        const data = (result as { data?: { providers?: Array<unknown> } }).data;
        const providers = data?.providers;
        if (!Array.isArray(providers) || providers.length === 0) {
            sessionLog(
                "global",
                "models-dev-cache: API refresh returned no providers payload (will retry if attempts remain)",
            );
            return false;
        }

        const map = new Map<string, CachedModelMetadata>();
        for (const entry of providers) {
            const p = entry as {
                id?: string;
                models?: Record<
                    string,
                    {
                        limit?: ModelLimit;
                        experimental?: { modes?: Record<string, unknown> };
                    }
                >;
            };
            if (!p?.id || !p.models || typeof p.models !== "object") continue;
            for (const [modelId, model] of Object.entries(p.models)) {
                setCachedModelMetadata(map, `${p.id}/${modelId}`, model);
            }
        }

        const previousSize = apiCache?.size ?? null;
        apiCache = map;
        apiLoadedAt = Date.now();
        // `persistApiCache` preserves sane-filtered limits for the next cold start.
        persistApiCache();

        if (previousSize === null) {
            sessionLog(
                "global",
                `models-dev-cache: API layer loaded ${map.size} model metadata entries`,
            );
        } else if (previousSize !== map.size) {
            sessionLog(
                "global",
                `models-dev-cache: API layer loaded ${map.size} model metadata entries (was ${previousSize})`,
            );
        }
        return true;
    } catch (error) {
        sessionLog(
            "global",
            "models-dev-cache: API refresh failed:",
            error instanceof Error ? error.message : String(error),
        );
        return false;
    }
}

/**
 * The resolver uses OpenCode's `config.providers()` SDK result for prompt limits.
 * The resolver does not read OpenCode's `models.json` file directly.
 * A read of that file during a write can produce invalid limits.
 *
 * Resolution:
 * Cold start seeds `apiCache` from the persisted last-known-good file once.
 * The resolver converts raw SDK metadata into an output-reserved usable limit.
 * `undefined` leaves fallback and retry behavior to the caller.
 *
 * Pi resolves limits from `ctx.model.contextWindow` instead of warming `apiCache`.
 * Pi uses `ctx.model.contextWindow` when this function returns `undefined`.
 */
export function getSdkWindowGeometry(
    providerID: string,
    modelID: string,
    detectedContextLimit?: number,
    options?: {
        detectedLimitProvenance?: ContextLimitProvenance;
        harness?: "opencode" | "pi";
    },
): WindowGeometryResult | undefined {
    loadPersistedApiCacheOnce();
    const metadata = lookupMetadataWithTagFallback(apiCache, providerID, modelID);
    if (!metadata) return undefined;
    const rawContext = metadata.contextLimit ?? metadata.limit;
    const promptOnlyDetected =
        options?.detectedLimitProvenance === "prompt_only" && isFinitePositive(detectedContextLimit)
            ? detectedContextLimit
            : undefined;
    const result = deriveWindowGeometry(
        providerID,
        modelID,
        {
            context: rawContext,
            input: metadata.inputLimit,
            output: metadata.outputLimit,
        },
        {
            overlay: resolveWindowOverlayFacts(providerID, modelID, getWindowOverlay()),
            outputReserveOverride: resolveOutputReserve(providerID, modelID),
            harness: options?.harness ?? "opencode",
            contextCap:
                promptOnlyDetected === undefined && isFinitePositive(detectedContextLimit)
                    ? detectedContextLimit
                    : undefined,
        },
    );
    if (!result || promptOnlyDetected === undefined) return result;
    const usableSoft = promptOnlyDetected;
    return {
        ...result,
        usableSoft,
        usableHard: Math.max(usableSoft, Math.min(result.usableHard, promptOnlyDetected)),
    };
}

export function getSdkContextLimit(
    providerID: string,
    modelID: string,
    detectedContextLimit?: number,
    options?: {
        reservation?: "default" | "none";
        detectedLimitProvenance?: ContextLimitProvenance;
    },
): number | undefined {
    if (options?.reservation !== "none") {
        return getSdkWindowGeometry(providerID, modelID, detectedContextLimit, {
            detectedLimitProvenance: options?.detectedLimitProvenance,
        })?.usableSoft;
    }
    loadPersistedApiCacheOnce();
    const metadata = lookupMetadataWithTagFallback(apiCache, providerID, modelID);
    if (!metadata) return undefined;
    const rawContext = metadata.contextLimit ?? metadata.limit;
    const promptOnlyDetected =
        options?.detectedLimitProvenance === "prompt_only" && isFinitePositive(detectedContextLimit)
            ? detectedContextLimit
            : undefined;
    const context =
        promptOnlyDetected === undefined &&
        isFinitePositive(detectedContextLimit) &&
        isFinitePositive(rawContext)
            ? Math.min(rawContext, detectedContextLimit)
            : promptOnlyDetected === undefined && isFinitePositive(detectedContextLimit)
              ? detectedContextLimit
              : rawContext;
    const inputCandidates = [metadata.inputLimit, promptOnlyDetected].filter(isFinitePositive);
    const input = inputCandidates.length > 0 ? Math.min(...inputCandidates) : undefined;
    return resolveLimit(
        {
            context,
            input,
            output: metadata.outputLimit,
        },
        providerID,
        modelID,
        options?.reservation === "none" ? 0 : undefined,
    );
}

/**
 */
/** Image-input support uses the same models.dev metadata cache as limits. */
export function modelSupportsVision(providerID: string, modelID: string): boolean {
    loadPersistedApiCacheOnce();
    if (!apiCache) return false;
    const exact = apiCache.get(`${providerID}/${modelID}`);
    if (exact?.vision === true) return true;
    const colon = modelID.lastIndexOf(":");
    return colon > 0
        ? apiCache.get(`${providerID}/${modelID.slice(0, colon)}`)?.vision === true
        : false;
}

export function getSdkInputLimit(providerID: string, modelID: string): number | undefined {
    loadPersistedApiCacheOnce();
    if (!apiCache) return undefined;
    const direct = apiCache.get(`${providerID}/${modelID}`)?.inputLimit;
    if (isSaneLimit(direct)) return direct;
    const colon = modelID.indexOf(":");
    if (colon > 0) {
        const tagless = apiCache.get(`${providerID}/${modelID.slice(0, colon)}`)?.inputLimit;
        if (isSaneLimit(tagless)) return tagless;
    }
    return undefined;
}

/**
 * Exact lookup precedes fallback so models with tagged metadata remain distinct.
 *
 */
function lookupMetadataWithTagFallback(
    cache: Map<string, CachedModelMetadata> | null,
    providerID: string,
    modelID: string,
): CachedModelMetadata | undefined {
    if (!cache) return undefined;
    const exact = cache.get(`${providerID}/${modelID}`);
    if (exact) return exact;

    const colonIdx = modelID.lastIndexOf(":");
    if (colonIdx > 0) {
        return cache.get(`${providerID}/${modelID.slice(0, colonIdx)}`);
    }
    return undefined;
}

/* */
export function clearModelsDevCache(): void {
    apiCache = null;
    apiLoadedAt = 0;
    persistSeedLoaded = false;
}

/* */
export function getModelsDevCacheState(): {
    apiLoaded: boolean;
    apiCount: number;
    apiAgeMs: number;
} {
    return {
        apiLoaded: apiCache !== null,
        apiCount: apiCache?.size ?? 0,
        apiAgeMs: apiLoadedAt > 0 ? Date.now() - apiLoadedAt : -1,
    };
}
