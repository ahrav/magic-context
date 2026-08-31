import { trimMemoriesToBudgetV2 } from "../../../hooks/magic-context/inject-compartments";
import type { Memory } from "../memory/types";

/**
 */
export const DEFAULT_MURAL_MEMORY_BUDGET = 8_000;

/**
 */
export function muralOverflowMemories(
    memories: readonly Memory[],
    budgetTokens = DEFAULT_MURAL_MEMORY_BUDGET,
): Memory[] {
    const selected = trimMemoriesToBudgetV2(
        "mural-selection",
        [...memories],
        budgetTokens,
    ).selected;
    const selectedIds = new Set(selected.map((memory) => memory.id));
    return memories.filter((memory) => !selectedIds.has(memory.id));
}
