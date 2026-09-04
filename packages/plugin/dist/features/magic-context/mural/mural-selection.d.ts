import type { Memory } from "../memory/types";
/**
 * The mural memory budget: the token budget the overflow set is computed
 * against. Callers pass the project's configured memory injection budget so the
 * mural shows exactly the memories the m0 injection dropped; this constant is
 * the fallback when no budget is supplied.
 */
export declare const DEFAULT_MURAL_MEMORY_BUDGET = 8000;
/**
 * The mural overflow set: memories that did NOT fit the m0 memory budget. This
 * is the COMPLEMENT of the same rank-ordered budget trim the m0 injection path
 * runs, so the mural surfaces exactly what the budget pushed out — the material
 * the agent would otherwise never see. Selection is deterministic; nothing here
 * calls an LLM.
 */
export declare function muralOverflowMemories(memories: readonly Memory[], budgetTokens?: number): Memory[];
//# sourceMappingURL=mural-selection.d.ts.map