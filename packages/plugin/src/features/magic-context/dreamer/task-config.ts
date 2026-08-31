import type { DreamerConfig, DreamTaskConfig } from "../../../config/schema/magic-context";
import { resolveFallbackChain } from "../../../shared/resolve-fallbacks";
import { CANONICAL_DREAM_TASKS, type DreamTaskName } from "./task-registry";
import type { DreamTaskRuntimeConfig } from "./task-scheduler";

/**
 */
export function buildDreamTaskRuntimeConfigs(
    dreamer: DreamerConfig,
    language?: string,
): DreamTaskRuntimeConfig[] {
    const tasks = (dreamer.tasks ?? {}) as Partial<DreamerConfig["tasks"]>;
    return CANONICAL_DREAM_TASKS.map((task) => {
        const t = (tasks[task] ?? {
            schedule: "",
            timeout_minutes: 20,
        }) as DreamTaskConfig;
        const model = task === "compress-cues" ? t.model : (t.model ?? dreamer.model);
        const fallbackModels = resolveFallbackChain(t.fallback_models ?? dreamer.fallback_models);
        const thinkingLevel = t.thinking_level ?? dreamer.thinking_level;
        return {
            task,
            schedule: t.schedule,
            model,
            fallbackModels,
            thinkingLevel,
            language,
            timeoutMinutes: t.timeout_minutes ?? 20,
            promotionThreshold: t.promotion_threshold,
        };
    });
}

/**
 * fallback configuration.
 */
export const MAX_CLASSIFY_MODEL_CHAIN = 8;

/* */
export function buildClassifyModelChain(
    taskModel: string | undefined,
    dreamerModel: string | undefined,
    fallbackModels: readonly string[] | undefined,
): string[] {
    return resolveFallbackChain([
        taskModel ?? "",
        dreamerModel ?? "",
        ...(fallbackModels ?? []),
    ]).slice(0, MAX_CLASSIFY_MODEL_CHAIN);
}

/**
 */
export function userMemoryCollectionEnabled(dreamer: DreamerConfig | undefined): boolean {
    const schedule = dreamer?.tasks?.["review-user-memories"]?.schedule;
    return typeof schedule === "string" && schedule.trim() !== "";
}

/* */
export function userMemoryPromotionThreshold(dreamer: DreamerConfig | undefined): number {
    return dreamer?.tasks?.["review-user-memories"]?.promotion_threshold ?? 3;
}

/* */
export function dreamTaskScheduled(
    dreamer: DreamerConfig | undefined,
    task: keyof NonNullable<DreamerConfig["tasks"]>,
): boolean {
    const schedule = dreamer?.tasks?.[task]?.schedule;
    return typeof schedule === "string" && schedule.trim() !== "";
}

/* */
export function enabledDreamTasks(dreamer: DreamerConfig | undefined): DreamTaskName[] {
    if (!dreamer?.tasks) return [];
    return CANONICAL_DREAM_TASKS.filter((t) => dreamer.tasks[t]?.schedule?.trim());
}

/**
 *  scheduled. */
export function summarizeDreamSchedule(dreamer: DreamerConfig | undefined): string {
    const enabled = enabledDreamTasks(dreamer);
    if (enabled.length === 0) return "manual-only";
    return enabled.map((t) => `${t} ${dreamer?.tasks[t]?.schedule}`).join(", ");
}
