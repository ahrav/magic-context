/**
 * Deterministic tier-decay curve (v2 cache architecture).
 *
 * Pure functions that select which paraphrase tier (P1..P4) renders for each
 * compartment, and which compartments are archived (P5, not rendered). These
 * REPLACE the LLM compressor and the per-compartment `compression_depth`
 * machinery: tier demotion is byte-deterministic at render time, driven by
 * compartment age, historian-emitted importance (semantically a *decay rate*),
 * and live budget pressure.
 *
 * This is a faithful implementation of the council-validated, empirically-
 * grounded model documented in `.alfonso/plans/decay-curve-formula.md`. The
 * hyperparameters, tier-cost constants, and log-cost boundary values come from
 * that document (boundaries derived from measured v8.3 Flash tier costs). The
 * model's invariants — age/importance monotonicity, finite demotion even at
 * importance 100, append stability, O(H) render cost, and budget self-tuning
 * across model/budget changes — were independently verified there.
 *
 * Anchor overlap (the archive-protection input `o`) is reserved for a future
 * release: anchors are not a reliable first-class storage primitive today (they
 * live inline in P4 text), so callers pass `0` and the archive predicate cleanly
 * reduces to `z >= Z4`. The parameter is kept so the wiring is ready when
 * anchor extraction lands.
 */
/** Half-life (in compartments) for importance 50 at pressure 1. */
export declare const H50 = 24;
/** Importance points needed to double the half-life (imp 75 → 2×, 100 → 4×). */
export declare const D = 25;
/** Max extra half-lives of P4 protection from full anchor overlap. */
export declare const G = 2;
export declare const Z1 = 0.201;
export declare const Z2 = 0.729;
export declare const Z3 = 1.322;
export declare const Z4 = 2.587;
/** Pressure floor: prevents div-by-zero and caps relaxation at 10×. */
export declare const P_FLOOR = 0.1;
/** Per-tier average token cost, indexed by tier number (1..5). Index 0 unused. */
export declare const TIER_COST: readonly [0, 322, 109, 35, 20, 5];
export type Tier = 1 | 2 | 3 | 4 | 5;
/**
 * Which paraphrase tier a compartment renders at, ignoring archive protection.
 * @param compartmentIndex 1-based position from newest (1 = newest).
 * @param importance 1..100 (historian-emitted decay rate).
 * @param budgetPressure 0.10..∞ (computed once per pass via computeBudgetPressure).
 */
export declare function tier(compartmentIndex: number, importance: number, budgetPressure: number): Tier;
/**
 * Whether a compartment should be archived (P5, not rendered). Anchor overlap
 * extends P4 protection by up to G half-lives; with `o = 0` (v2.0 default) this
 * reduces to `z >= Z4`.
 */
export declare function shouldArchive(compartmentIndex: number, importance: number, budgetPressure: number, anchorOverlap?: number): boolean;
/**
 * Final rendered tier combining base tier + archive protection. Archived
 * compartments return 5; anchor-protected ones render at P4 (anchor-only)
 * instead of P5, preserving the topic until anchor overlap fades.
 */
export declare function renderedTier(compartmentIndex: number, importance: number, budgetPressure: number, anchorOverlap?: number): Tier;
/**
 * Compute budget pressure for a render pass in a single forward pass. Because
 * H ∝ 1/p, the count of compartments in each tier also scales as 1/p, so
 * C(p) ≈ C(1)/p; setting p = C(1)/B gives C(p) ≈ B. Overshoots up to ~30% at
 * very tight budgets (<8K) — use computeBudgetPressureTwoPass there.
 */
export declare function computeBudgetPressure(compartments: ReadonlyArray<{
    index: number;
    importance: number;
}>, historyBudget: number): number;
/**
 * Two-pass pressure for tight budgets — converges to within ~1% of budget at
 * ~2µs extra cost. Recompute actual cost at the single-pass pressure and, if it
 * still overshoots by >10%, scale pressure proportionally.
 */
export declare function computeBudgetPressureTwoPass(compartments: ReadonlyArray<{
    index: number;
    importance: number;
}>, historyBudget: number): number;
//# sourceMappingURL=decay-curve.d.ts.map