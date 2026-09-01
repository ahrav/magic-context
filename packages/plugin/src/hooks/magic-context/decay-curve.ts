/**
 *
 * The renderer selects a P1–P4 paraphrase tier for each compartment.
 * P5 compartments are archived rather than rendered.
 * Importance controls the demotion half-life.
 *
 * Increasing compartmentIndex never promotes a tier; increasing importance never demotes one.
 * Importance 100 still demotes in finite time.
 *
 */

/** Half-life (in compartments) for importance 50 at pressure 1. */
export const H50 = 24;
/** Importance points needed to double the half-life (imp 75 → 2×, 100 → 4×). */
export const D = 25;
/** Max extra half-lives of P4 protection from full anchor overlap. */
export const G = 2;

export const Z1 = 0.201; // P1→P2
export const Z2 = 0.729; // P2→P3
export const Z3 = 1.322; // P3→P4
export const Z4 = 2.587; // P4→P5 (archive candidate)

/** Pressure floor: prevents div-by-zero and caps relaxation at 10×. */
export const P_FLOOR = 0.1;

/* */
export const TIER_COST = [0, 322, 109, 35, 20, 5] as const;

export type Tier = 1 | 2 | 3 | 4 | 5;

/**
 * Which paraphrase tier a compartment renders at, ignoring archive protection.
 * @param compartmentIndex 1-based position from newest (1 = newest).
 */
export function tier(compartmentIndex: number, importance: number, budgetPressure: number): Tier {
    const a = Math.max(compartmentIndex, 1) - 1;
    const imp = Math.max(1, Math.min(100, importance));
    const p = Math.max(budgetPressure, P_FLOOR);

    const F = 2 ** ((imp - 50) / D);
    const H = (H50 * F) / p;
    const z = a / H;

    if (z < Z1) return 1;
    if (z < Z2) return 2;
    if (z < Z3) return 3;
    if (z < Z4) return 4;
    return 5;
}

/**
 */
export function shouldArchive(
    compartmentIndex: number,
    importance: number,
    budgetPressure: number,
    anchorOverlap = 0,
): boolean {
    const a = Math.max(compartmentIndex, 1) - 1;
    const imp = Math.max(1, Math.min(100, importance));
    const p = Math.max(budgetPressure, P_FLOOR);
    const o = Math.max(0, Math.min(1, anchorOverlap));

    const F = 2 ** ((imp - 50) / D);
    const H = (H50 * F) / p;
    const z = a / H;

    return z >= Z4 + G * o;
}

/**
 * Anchor overlap causes compartments whose base tier is P5 to render at P4 until archival.
 */
export function renderedTier(
    compartmentIndex: number,
    importance: number,
    budgetPressure: number,
    anchorOverlap = 0,
): Tier {
    if (shouldArchive(compartmentIndex, importance, budgetPressure, anchorOverlap)) {
        return 5;
    }
    const base = tier(compartmentIndex, importance, budgetPressure);
    return Math.min(base, 4) as Tier;
}

/**
 * Effective pressure above P_FLOOR reduces H and never decreases a tier.
 */
export function computeBudgetPressure(
    compartments: ReadonlyArray<{ index: number; importance: number }>,
    historyBudget: number,
): number {
    if (historyBudget <= 0) return 1;
    let naturalCost = 0;
    for (const c of compartments) {
        const naturalTier = tier(c.index, c.importance, 1.0);
        naturalCost += naturalTier >= 5 ? 0 : TIER_COST[naturalTier];
    }
    return Math.max(P_FLOOR, naturalCost / historyBudget);
}

/**
 */
export function computeBudgetPressureTwoPass(
    compartments: ReadonlyArray<{ index: number; importance: number }>,
    historyBudget: number,
): number {
    if (historyBudget <= 0) return 1;
    let p = computeBudgetPressure(compartments, historyBudget);
    let actualCost = 0;
    for (const c of compartments) {
        const actualTier = tier(c.index, c.importance, p);
        actualCost += actualTier >= 5 ? 0 : TIER_COST[actualTier];
    }
    if (actualCost > historyBudget * 1.1) {
        p = p * (actualCost / historyBudget);
    }
    return Math.max(P_FLOOR, p);
}
