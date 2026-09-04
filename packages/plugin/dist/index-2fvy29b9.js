import {
  resolveFallbackChain
} from "./index-td9depx5.js";

// src/features/magic-context/dreamer/task-registry.ts
var CANONICAL_DREAM_TASKS = [
  "map-memories",
  "verify",
  "verify-broad",
  "curate",
  "compress-cues",
  "classify-memories",
  "retrospective",
  "maintain-docs",
  "evaluate-smart-notes",
  "review-user-memories",
  "promote-primers",
  "refresh-primers"
];
function formatDreamTaskBacklogs(backlogs, tasks = CANONICAL_DREAM_TASKS) {
  return tasks.filter((task) => backlogs[task] !== undefined).map((task) => {
    const backlog = backlogs[task];
    return `- ${task}: ${backlog?.pending ?? 0} pending / ${backlog?.total ?? 0} total`;
  }).join(`
`);
}
function processedDreamTaskItems(startPending, endPending) {
  return Math.max(0, startPending - endPending);
}
var MEMORY_DOMAIN_TASKS = [
  "map-memories",
  "verify",
  "verify-broad",
  "curate",
  "compress-cues",
  "classify-memories",
  "retrospective",
  "promote-primers",
  "refresh-primers"
];
var MEMORY_DOMAIN_SET = new Set(MEMORY_DOMAIN_TASKS);
function leaseKindFor(task) {
  if (MEMORY_DOMAIN_SET.has(task))
    return "memory";
  switch (task) {
    case "review-user-memories":
      return "user-memories";
    case "promote-primers":
    case "refresh-primers":
      return "memory";
    case "maintain-docs":
      return "maintain-docs";
    case "evaluate-smart-notes":
      return "evaluate-smart-notes";
    default:
      return "memory";
  }
}
function leaseKeyFor(task, projectIdentity) {
  const kind = leaseKindFor(task);
  return kind === "user-memories" ? "user-memories" : `${kind}:${projectIdentity}`;
}
function isCanonicalDreamTask(value) {
  return CANONICAL_DREAM_TASKS.includes(value);
}
function compareTaskOrder(a, b) {
  return CANONICAL_DREAM_TASKS.indexOf(a) - CANONICAL_DREAM_TASKS.indexOf(b);
}

// src/features/magic-context/dreamer/task-config.ts
function buildDreamTaskRuntimeConfigs(dreamer, language) {
  const tasks = dreamer.tasks ?? {};
  return CANONICAL_DREAM_TASKS.map((task) => {
    const t = tasks[task] ?? {
      schedule: "",
      timeout_minutes: 20
    };
    const model = task === "compress-cues" ? t.model : t.model ?? dreamer.model;
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
      promotionThreshold: t.promotion_threshold
    };
  });
}
var MAX_CLASSIFY_MODEL_CHAIN = 8;
function buildClassifyModelChain(taskModel, dreamerModel, fallbackModels) {
  return resolveFallbackChain([
    taskModel ?? "",
    dreamerModel ?? "",
    ...fallbackModels ?? []
  ]).slice(0, MAX_CLASSIFY_MODEL_CHAIN);
}
function userMemoryCollectionEnabled(dreamer) {
  const schedule = dreamer?.tasks?.["review-user-memories"]?.schedule;
  return typeof schedule === "string" && schedule.trim() !== "";
}
function userMemoryPromotionThreshold(dreamer) {
  return dreamer?.tasks?.["review-user-memories"]?.promotion_threshold ?? 3;
}
function dreamTaskScheduled(dreamer, task) {
  const schedule = dreamer?.tasks?.[task]?.schedule;
  return typeof schedule === "string" && schedule.trim() !== "";
}
function enabledDreamTasks(dreamer) {
  if (!dreamer?.tasks)
    return [];
  return CANONICAL_DREAM_TASKS.filter((t) => dreamer.tasks[t]?.schedule?.trim());
}
function summarizeDreamSchedule(dreamer) {
  const enabled = enabledDreamTasks(dreamer);
  if (enabled.length === 0)
    return "manual-only";
  return enabled.map((t) => `${t} ${dreamer?.tasks[t]?.schedule}`).join(", ");
}

export { CANONICAL_DREAM_TASKS, formatDreamTaskBacklogs, processedDreamTaskItems, leaseKindFor, leaseKeyFor, isCanonicalDreamTask, compareTaskOrder, buildDreamTaskRuntimeConfigs, MAX_CLASSIFY_MODEL_CHAIN, buildClassifyModelChain, userMemoryCollectionEnabled, userMemoryPromotionThreshold, dreamTaskScheduled, enabledDreamTasks, summarizeDreamSchedule };
