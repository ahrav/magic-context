/**
 *
 *
 * The function does not mutate `rawConfig`.
 *
 *
 * When both values are objects, destination fields override matching legacy fields and legacy fields fill missing destination fields.
 */
export function migrateLegacyExperimental(
    rawConfig: Record<string, unknown>,
    warnings: string[],
): Record<string, unknown> {
    const experimental = rawConfig.experimental;
    if (typeof experimental !== "object" || experimental === null) {
        return rawConfig;
    }
    const exp = experimental as Record<string, unknown>;
    const hasUM = "user_memories" in exp;
    const hasPKF = "pin_key_files" in exp;
    const hasMural = "mural" in exp;
    const TOP_LEVEL_GRADUATED = ["temporal_awareness", "caveman_text_compression"] as const;
    const MEMORY_GRADUATED = ["auto_search", "git_commit_indexing"] as const;
    const hasGraduated =
        TOP_LEVEL_GRADUATED.some((k) => k in exp) ||
        MEMORY_GRADUATED.some((k) => k in exp) ||
        hasMural;
    if (!hasUM && !hasPKF && !hasGraduated) {
        return rawConfig;
    }

    const patched: Record<string, unknown> = { ...rawConfig };
    const dreamer =
        typeof patched.dreamer === "object" && patched.dreamer !== null
            ? { ...(patched.dreamer as Record<string, unknown>) }
            : ({} as Record<string, unknown>);
    const memory =
        typeof patched.memory === "object" && patched.memory !== null
            ? { ...(patched.memory as Record<string, unknown>) }
            : ({} as Record<string, unknown>);
    const newExperimental = { ...exp };

    const coerceToObject = (value: unknown): Record<string, unknown> | undefined => {
        if (typeof value === "boolean") {
            return { enabled: value };
        }
        if (typeof value === "object" && value !== null) {
            return { ...(value as Record<string, unknown>) };
        }
        return undefined;
    };

    // A defined destination value overrides the legacy value.
    const relocate = (key: string, dest: Record<string, unknown>, destLabel: string): void => {
        if (!(key in exp)) return;
        const oldValue = exp[key];
        const existing = dest[key];
        if (existing === undefined) {
            dest[key] = oldValue;
            warnings.push(
                `Migrated "experimental.${key}" → "${destLabel}${key}" in-memory (run \`doctor\` to persist).`,
            );
        } else if (
            typeof oldValue === "object" &&
            oldValue !== null &&
            typeof existing === "object" &&
            existing !== null
        ) {
            dest[key] = {
                ...(oldValue as Record<string, unknown>),
                ...(existing as Record<string, unknown>),
            };
        }
        delete newExperimental[key];
    };
    for (const key of TOP_LEVEL_GRADUATED) relocate(key, patched, "");
    for (const key of MEMORY_GRADUATED) relocate(key, memory, "memory.");

    if (hasMural) {
        const oldMural = coerceToObject(exp.mural);
        const existingMural = patched.mural;
        if (existingMural === undefined) {
            patched.mural = oldMural ?? exp.mural;
            warnings.push(
                'Deprecated "experimental.mural"; use top-level "mural" instead (migrated in memory; run `doctor` to persist).',
            );
        } else if (
            oldMural !== undefined &&
            typeof existingMural === "object" &&
            existingMural !== null &&
            !Array.isArray(existingMural)
        ) {
            patched.mural = {
                ...oldMural,
                ...(existingMural as Record<string, unknown>),
            };
        }
        delete newExperimental.mural;
    }

    if (hasUM) {
        const oldUM = coerceToObject(exp.user_memories);
        if (oldUM !== undefined) {
            if (dreamer.user_memories === undefined) {
                dreamer.user_memories = oldUM;
                warnings.push(
                    'Migrated "experimental.user_memories" → "dreamer.user_memories" in-memory (run `doctor` to persist).',
                );
            } else if (
                typeof dreamer.user_memories === "object" &&
                dreamer.user_memories !== null
            ) {
                // The migration preserves `experimental.user_memories` fields absent from `dreamer.user_memories`; `dreamer.user_memories` overrides conflicts.
                dreamer.user_memories = {
                    ...oldUM,
                    ...(dreamer.user_memories as Record<string, unknown>),
                };
            }
        }
        delete newExperimental.user_memories;
    }

    if (hasPKF) {
        const oldPKF = coerceToObject(exp.pin_key_files);
        if (oldPKF !== undefined) {
            if (dreamer.pin_key_files === undefined) {
                dreamer.pin_key_files = oldPKF;
                warnings.push(
                    'Migrated "experimental.pin_key_files" → "dreamer.pin_key_files" in-memory (run `doctor` to persist).',
                );
            } else if (
                typeof dreamer.pin_key_files === "object" &&
                dreamer.pin_key_files !== null
            ) {
                dreamer.pin_key_files = {
                    ...oldPKF,
                    ...(dreamer.pin_key_files as Record<string, unknown>),
                };
            } else if (typeof dreamer.pin_key_files === "boolean") {
                dreamer.pin_key_files = { ...oldPKF, enabled: dreamer.pin_key_files };
            }
        }
        delete newExperimental.pin_key_files;
    }

    patched.experimental = newExperimental;
    patched.dreamer = dreamer;
    // The migration attaches `memory` only when it has keys to avoid creating an empty block for configs that migrate only top-level or `dreamer` keys.
    if (Object.keys(memory).length > 0) {
        patched.memory = memory;
    }
    return patched;
}
