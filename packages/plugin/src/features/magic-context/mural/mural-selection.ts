/**
 * The mural memory budget: the token budget the overflow set is computed
 * against. Callers pass the project's configured memory injection budget so the
 * mural shows exactly the memories the m0 injection dropped; this constant is
 * the fallback when no budget is supplied.
 */
export const DEFAULT_MURAL_MEMORY_BUDGET = 8_000;
