/**
 * Resolve per-model context limits from OpenCode's SDK — the single source of
 * truth — for OpenCode sessions.
 *
 * `client.config.providers()` returns OpenCode's fully-resolved config: the
 * live models.dev cache + compiled-in snapshot + opencode.json custom-provider
 * overrides + auth-plugin caps (e.g. the Codex-OAuth gpt-5.5 400k cap). We
 * consume ONLY that. We no longer read OpenCode's `models.json` file ourselves:
 * a torn read mid-write produced impossible limits (a 6748 "limit" for a session
 * that had run for hours), and a stale on-disk copy out-voted the live
 * auth-resolved cap (922k vs the real 400k). OpenCode reads that file safely in
 * its own process and hands us the merged answer.
 *
 * Layers:
 *   1. `apiCache` (authoritative): warmed once at startup from the SDK; seeded
 *      from a persisted last-known-good file on cold start so a restart uses the
 *      real limit immediately (no 128k-default budget-collapse window).
 *
 * All cached values are bounded to a sane [20k, 3M] range on insert, so torn /
 * unconfigured-default garbage can never be returned or persisted. The startup
 * warm retries a couple times when OpenCode's provider service isn't ready yet.
 *
 * Pi does NOT use this — it resolves from its own `ctx.getModel().contextWindow`
 * (instant at extension load), so `getSdkContextLimit()` returns `undefined`
 * for Pi and Pi's own path is used.
 */
import type { ContextLimitProvenance } from "./context-limit-provenance";
import { type WindowGeometryResult } from "./window-geometry";
interface OpencodeClientLike {
    config: {
        providers: () => Promise<{
            data?: {
                providers?: unknown;
            };
        }>;
    };
}
export declare const MIN_SANE_LIMIT = 20000;
export declare const MAX_SANE_LIMIT = 3000000;
/** True when `limit` is a plausible real prompt window — used to reject torn /
 *  unconfigured-default garbage in BOTH harnesses (OpenCode's SDK values and
 *  Pi's reported `contextWindow`). Exported so Pi applies the identical bound. */
export declare function isSaneLimit(limit: number | undefined): limit is number;
export type OutputReserveConfig = number | {
    default: number;
    [modelKey: string]: number;
};
export interface ModelLimit {
    context?: number;
    input?: number;
    output?: number;
}
/** Resolve the user-tier output reservation for one runtime model. */
export declare function resolveOutputReserve(providerID: string, modelID: string, config?: OutputReserveConfig | undefined): number | undefined;
/** Set the user-tier reservation override shared by every resolved-limit consumer. */
export declare function setOutputReserveConfig(config: OutputReserveConfig | undefined): void;
/**
 * Resolve the usable prompt budget from raw provider metadata.
 *
 * A genuinely smaller input cap is already pre-carved and wins unchanged. All
 * other providers reserve generated tokens from the shared context window by
 * default, except the small allowlist whose APIs document a separate output
 * quota. `output_reserve` overrides that shared/separate decision, including 0
 * to disable reservation. Reservation can never leave less than half the raw
 * context window or the module's 1024-token plausibility floor.
 */
export declare function resolveLimit(limit: ModelLimit | undefined, providerID: string, modelID: string, reserveConfig?: OutputReserveConfig | undefined): number | undefined;
/**
 * Asynchronously refresh the API-layer cache from OpenCode's SDK.
 *
 * Call this at plugin startup and from the issue #77 regression-recovery path.
 * OpenCode's `/config/providers` endpoint returns every provider with full
 * model metadata — including `limit.context` — resolved through the same path
 * OpenCode itself uses (live cache + compiled-in snapshot + opencode.json
 * overrides + derived experimental modes + auth-plugin caps).
 *
 * `retries`/`retryDelayMs`: when OpenCode's provider service isn't ready at our
 * startup, `config.providers()` can return an empty/no-providers payload. Retry
 * a few times so the cache warms instead of leaving the session on the 128k
 * default until the next restart. A successful load (any providers) stops early.
 *
 * Safe to call concurrently; only overwrites the cache on success.
 */
export declare function refreshModelLimitsFromApi(client: OpencodeClientLike, options?: {
    retries?: number;
    retryDelayMs?: number;
}): Promise<void>;
/**
 * Re-warm the limit cache ONCE per process, after auth is provably live.
 *
 * The startup warm (index.ts) can run before the user's provider auth is
 * loaded. When it does, an auth-conditional limit patch hasn't applied yet, so
 * `config.providers()` returns the RAW catalog limit (e.g. OpenAI gpt-5.5 OAuth
 * is downshifted to a 272k input cap by OpenCode's Codex auth plugin only when
 * `ctx.auth.type === "oauth"`; before auth loads it reports the raw 922k). That
 * too-high value gets cached AND persisted as last-known-good, survives
 * restarts, and the existing recovery only re-resolves a too-LOW limit
 * (overflow / `percentage > 100`), so a too-HIGH one never self-corrects: the
 * sidebar shows huge headroom while the backend rejects at the real cap (#179).
 *
 * The first `message.updated` carrying usage tokens proves a request succeeded,
 * so auth + providers are fully resolved. Re-warming there overwrites any stale
 * pre-auth limit with the live auth-adjusted one. Idempotent and cheap: a single
 * `config.providers()` round-trip, then a no-op for the rest of the process. The
 * latch is set before the await so concurrent `message.updated` events don't
 * stack duplicate warms; a failed warm resets it so a later message retries.
 */
export declare function refreshModelLimitsAfterAuthOnce(client: OpencodeClientLike): Promise<void>;
/** Test-only: reset the after-auth re-warm latch between cases. */
export declare function resetAuthRewarmLatchForTest(): void;
/**
 * Resolve a model's prompt limit from OpenCode's SDK (`config.providers()`),
 * the single source of truth: it already merges models.dev + compiled-in
 * snapshot + opencode.json overrides + auth-plugin caps (e.g. the Codex-OAuth
 * gpt-5.5 400k cap). We deliberately do NOT read OpenCode's `models.json` file
 * ourselves — a torn read of that file mid-write produced garbage limits, and a
 * stale on-disk copy out-voted the live auth-resolved cap (922k vs the real
 * 400k). OpenCode reads that file safely within its own process and exposes the
 * merged result here.
 *
 * Resolution:
 *   1. Seed `apiCache` from the persisted last-known-good file once (cold start).
 *   2. Resolve the sane raw SDK metadata into its output-reserved usable value.
 *   3. `undefined` when the SDK hasn't reported this model yet → the caller
 *      defaults / retries (the startup warm retries when OpenCode isn't ready).
 *
 * OpenCode-only: Pi never warms `apiCache` (it resolves from its own
 * `ctx.model.contextWindow`), so for Pi this returns `undefined` and Pi's
 * own resolution path is used.
 */
export declare function getSdkWindowGeometry(providerID: string, modelID: string, detectedContextLimit?: number, options?: {
    detectedLimitProvenance?: ContextLimitProvenance;
    harness?: "opencode" | "pi";
}): WindowGeometryResult | undefined;
export declare function getSdkContextLimit(providerID: string, modelID: string, detectedContextLimit?: number, options?: {
    reservation?: "default" | "none";
    detectedLimitProvenance?: ContextLimitProvenance;
}): number | undefined;
/**
 * Return only a provider-declared input cap. A combined context window is useful
 * for scheduling but is not safe as a fail-closed prompt boundary.
 */
/** Resolve image-input support from the same models.dev metadata cache as limits. */
export declare function modelSupportsVision(providerID: string, modelID: string): boolean;
export declare function getSdkInputLimit(providerID: string, modelID: string): number | undefined;
/** Clear in-memory caches (for testing and the regression-recovery refetch). */
export declare function clearModelsDevCache(): void;
/** Inspection helpers (for logging / debugging). */
export declare function getModelsDevCacheState(): {
    apiLoaded: boolean;
    apiCount: number;
    apiAgeMs: number;
};
export {};
//# sourceMappingURL=models-dev-cache.d.ts.map