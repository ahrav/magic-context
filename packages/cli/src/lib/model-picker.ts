/**
 *
 */
import type { PromptIO, SelectOption } from "./prompts";

export type ModelRole = "historian" | "dreamer" | "sidekick";

interface RoleCopy {
    title: string;
    /* */
    blurb: string;
    pickMessage: string;
    placeholder: string;
}

const ROLE_COPY: Record<ModelRole, RoleCopy> = {
    historian: {
        title: "Historian",
        blurb:
            "The historian runs in the background and condenses older conversation into\n" +
            "compact summaries, so your context never overflows. It works on one bounded\n" +
            "chunk at a time and runs often — it does NOT need a frontier model. A smaller,\n" +
            "cheaper, faster model (a mini / flash / haiku tier) works well here and keeps\n" +
            "your costs down.",
        pickMessage: "Select a model for the historian",
        placeholder: "type to filter (e.g. haiku, flash, mini)…",
    },
    dreamer: {
        title: "Dreamer",
        blurb:
            "The dreamer runs periodically (typically overnight) to consolidate and maintain\n" +
            "your project memories. It is not on the hot path and does NOT need a frontier\n" +
            "model — a cheaper or local model is a good fit here.",
        pickMessage: "Select a model for the dreamer",
        placeholder: "type to filter (e.g. flash, local, glm)…",
    },
    sidekick: {
        title: "Sidekick",
        blurb:
            "The sidekick augments your prompt with relevant project context when you run\n" +
            "/ctx-aug. Fast models are preferred here.",
        pickMessage: "Select a model for the sidekick",
        placeholder: "type to filter…",
    },
};

/**
 * Model IDs use `provider/model`, so sorting groups them by provider. */
export function sortModelsForPicker(models: string[]): string[] {
    return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

export function modelOptions(models: string[]): SelectOption[] {
    return sortModelsForPicker(models).map((model) => ({ label: model, value: model }));
}

/**
 * Free-text entry prevents an empty catalog from blocking setup.
 */
export async function pickModel(
    prompts: PromptIO,
    allModels: string[],
    role: ModelRole,
): Promise<string> {
    const copy = ROLE_COPY[role];
    prompts.note(copy.blurb, copy.title);

    const options = modelOptions(allModels);
    if (options.length === 0) {
        return (
            await prompts.text(`${copy.pickMessage} (type a provider/model id)`, {
                placeholder: "e.g. anthropic/claude-haiku-4-5",
                validate: (value) =>
                    value.trim().length === 0 ? "A model id is required" : undefined,
            })
        ).trim();
    }
    return prompts.selectAutocomplete(copy.pickMessage, options, {
        placeholder: copy.placeholder,
    });
}
