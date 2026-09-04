import type { MemoryCategory } from "./types";
/**
 * The v2 world taxonomy — the only categories agents may WRITE today. Exposed
 * as the ctx_memory schema enum so invalid categories fail at validation
 * instead of bouncing off a runtime check. Legacy 9-cat values remain readable
 * (CATEGORY_PRIORITY) for pre-v2 rows but are not accepted for new writes.
 */
export declare const V2_MEMORY_CATEGORIES: readonly ["PROJECT_RULES", "ARCHITECTURE", "CONSTRAINTS", "CONFIG_VALUES", "NAMING"];
/**
 * Rejected approaches live outside the writable taxonomy on purpose: the
 * generic claim operations refuse this category, and the only write path is
 * the typed API in `storage-anti-memory.ts`.
 */
export declare const ANTI_MEMORY_CATEGORY: "REJECTED_APPROACH";
/**
 * The category enum the `ctx_memory` tool exposes to agents. Deliberately wider
 * than `V2_MEMORY_CATEGORIES`: naming the anti-memory category is how an agent
 * selects the typed rejected-approach write arm, which the tool dispatches to
 * `storage-anti-memory.ts`. That keeps the storage-side refusal above intact —
 * this set governs what an agent may ASK for, not what the generic claim
 * operations accept — so the two must not be collapsed into one constant.
 */
export declare const WRITABLE_MEMORY_CATEGORIES: readonly ["PROJECT_RULES", "ARCHITECTURE", "CONSTRAINTS", "CONFIG_VALUES", "NAMING", "REJECTED_APPROACH"];
export declare const PROMOTABLE_CATEGORIES: MemoryCategory[];
export declare const CATEGORY_PRIORITY: MemoryCategory[];
export declare const MEMORY_CATEGORY_ORDER_UNKNOWN = 99;
export declare const MEMORY_CATEGORY_ORDER_PRIORITY: Record<MemoryCategory, number>;
export declare const MEMORY_CATEGORY_ORDER_SQL: string;
export declare function getMemoryCategoryOrder(category: string): number;
export declare const CATEGORY_DEFAULT_TTL: Partial<Record<MemoryCategory, number>>;
//# sourceMappingURL=constants.d.ts.map