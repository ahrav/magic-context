import type { AntiMemoryCategory, MemoryCategory, WritableMemoryCategory } from "./types";

/**
 */
export const V2_MEMORY_CATEGORIES = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
] as const satisfies readonly MemoryCategory[];

/**
 */
export const ANTI_MEMORY_CATEGORY = "REJECTED_APPROACH" as const satisfies AntiMemoryCategory;

/**
 */
export const WRITABLE_MEMORY_CATEGORIES = [
    ...V2_MEMORY_CATEGORIES,
    ANTI_MEMORY_CATEGORY,
] as const satisfies readonly WritableMemoryCategory[];

export const PROMOTABLE_CATEGORIES: MemoryCategory[] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
    "ARCHITECTURE_DECISIONS",
    "CONFIG_DEFAULTS",
    "USER_PREFERENCES",
    "USER_DIRECTIVES",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];

export const CATEGORY_PRIORITY: MemoryCategory[] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
    "USER_DIRECTIVES",
    "USER_PREFERENCES",
    "CONFIG_DEFAULTS",
    "ARCHITECTURE_DECISIONS",
    "ENVIRONMENT",
    "WORKFLOW_RULES",
    "KNOWN_ISSUES",
];

export const MEMORY_CATEGORY_ORDER_UNKNOWN = 99;

export const MEMORY_CATEGORY_ORDER_PRIORITY: Record<MemoryCategory, number> =
    CATEGORY_PRIORITY.reduce(
        (acc, category, index) => {
            acc[category] = index;
            return acc;
        },
        {} as Record<MemoryCategory, number>,
    );

export const MEMORY_CATEGORY_ORDER_SQL = `CASE category ${CATEGORY_PRIORITY.map(
    (category, index) => `WHEN '${category}' THEN ${index}`,
).join(" ")} ELSE ${MEMORY_CATEGORY_ORDER_UNKNOWN} END`;

export function getMemoryCategoryOrder(category: string): number {
    return (
        (MEMORY_CATEGORY_ORDER_PRIORITY as Record<string, number>)[category] ??
        MEMORY_CATEGORY_ORDER_UNKNOWN
    );
}
