/**
 *
 *
 */
import { isValidCron } from "@magic-context/core/features/magic-context/dreamer/cron";
import {
    CANONICAL_DREAM_TASKS,
    type DreamTaskName,
} from "@magic-context/core/features/magic-context/dreamer/task-registry";
import { pickModel } from "./model-picker";
import type { PromptIO, SelectOption } from "./prompts";

/* */
const TASK_DESCRIPTIONS: Record<DreamTaskName, string> = {
    "map-memories": "One-time: maps each memory to its backing files (prepares verify)",
    verify: "Checks changed-file memories against code and fixes/removes stale ones",
    "verify-broad": "Periodic full re-check of the whole memory pool (catches drift)",
    curate: "Deduplicates, tightens, and prunes the memory pool",
    "compress-cues":
        "Compresses each overflow memory into a mural cue (mural renders deterministically)",
    "classify-memories": "Scores memory importance, scope, and shareability",
    retrospective: "Learns from moments you had to correct or re-explain, and records the lesson",
    "maintain-docs": "Keep ARCHITECTURE.md / STRUCTURE.md in sync",
    "evaluate-smart-notes": "Surface smart notes whose conditions are now met",
    "review-user-memories": "Promote recurring behaviors into your user profile",
    "promote-primers": "Promote recurring project questions into Primers",
    "refresh-primers": "Refresh answers for active project Primers",
};

/* */
const DEFAULT_TASK_SCHEDULES: Record<DreamTaskName, string> = {
    "map-memories": "0 2 * * *",
    verify: "0 3 * * *",
    "verify-broad": "0 4 * * 0",
    curate: "0 4 * * 0",
    "compress-cues": "0 4 * * *",
    "classify-memories": "0 6 * * *",
    retrospective: "0 5 * * *",
    "maintain-docs": "",
    "evaluate-smart-notes": "0 3 * * *",
    "review-user-memories": "0 3 * * *",
    "promote-primers": "0 3 * * *",
    "refresh-primers": "0 3 * * *",
};

const PRESET_CUSTOM = "__custom__";

/* */
const SCHEDULE_PRESETS: { label: string; cron: string }[] = [
    { label: "Nightly (3am)", cron: "0 3 * * *" },
    { label: "Weekly (Sunday 3am)", cron: "0 3 * * 0" },
    { label: "Every 6 hours", cron: "0 */6 * * *" },
    { label: "Hourly", cron: "0 * * * *" },
    { label: "Disabled", cron: "" },
];

/**
 * */
function presetValueForCron(cron: string): string {
    const match = SCHEDULE_PRESETS.find((p) => p.cron === cron);
    return match ? match.cron : PRESET_CUSTOM;
}

function scheduleOptions(defaultCron: string): SelectOption[] {
    const recommended = presetValueForCron(defaultCron);
    const opts: SelectOption[] = SCHEDULE_PRESETS.map((p) => ({
        label: p.label,
        value: `cron:${p.cron}`,
        recommended: p.cron === recommended,
    }));
    opts.push({
        label: "Custom cron…",
        value: PRESET_CUSTOM,
        recommended: recommended === PRESET_CUSTOM,
    });
    return opts;
}

export interface DreamerSetupResult {
    model: string;
    /**
     * */
    tasks?: Record<string, { schedule: string }>;
}

/**
 */
export async function runDreamerSetup(
    prompts: PromptIO,
    allModels: string[],
): Promise<DreamerSetupResult> {
    const model = await pickModel(prompts, allModels, "dreamer");
    prompts.log.success(`Dreamer model: ${model}`);

    const useDefaults = await prompts.confirm(
        "Use recommended task schedules? (verify nightly; curate weekly; classify + retrospective daily; docs off)",
        true,
    );
    if (useDefaults) {
        return { model };
    }

    const tasks: Record<string, { schedule: string }> = {};
    for (const task of CANONICAL_DREAM_TASKS) {
        prompts.note(TASK_DESCRIPTIONS[task], task);
        const choice = await prompts.selectOne(
            `Schedule for "${task}"`,
            scheduleOptions(DEFAULT_TASK_SCHEDULES[task]),
        );
        let schedule: string;
        if (choice === PRESET_CUSTOM) {
            schedule = (
                await prompts.text("Enter a 5-field cron expression (empty to disable)", {
                    placeholder: "0 3 * * *",
                    validate: (value) => {
                        const v = value.trim();
                        if (v === "") return undefined; // empty = disabled
                        return isValidCron(v)
                            ? undefined
                            : 'Invalid cron. Use 5 fields, e.g. "0 3 * * *".';
                    },
                })
            ).trim();
        } else {
            schedule = choice.slice("cron:".length);
        }
        tasks[task] = { schedule };
        prompts.log.success(`${task}: ${schedule === "" ? "disabled" : schedule}`);
    }
    return { model, tasks };
}
