/**
 * Shared deterministic decay renderer (v2). Used by BOTH OpenCode
 * (inject-compartments.ts) and Pi (inject-compartments-pi.ts) so the two
 * harnesses render compartment history byte-identically from the same validated
 * decay curve. This is the single render-side implementation of the curve in
 * `decay-curve.ts`; neither harness may keep a private/approximate copy.
 *
 * Responsibilities:
 *  - Pick a tier per compartment from age + importance + budget pressure
 *    (decay-curve.ts), with budget pressure computed ONCE per pass.
 *  - Render the chosen paraphrase tier (P1..P4); P5 = archived (omitted).
 *  - Legacy (pre-v2, flat-content) compartments: no paraphrase columns, so the
 *    initial tier is P3 when the body has a `U:` line else P4, and the body is
 *    truncated `content`.
 *  - Demote oldest-first under a hard token budget (the curve already fits the
 *    budget, but this guards against estimate drift / very tight budgets).
 *
 * v2 faithful facts: this renderer NEVER emits a <session_facts> block. Facts
 * are promoted to project memory and render via <project-memory>. Callers pass
 * the memory block separately; session facts are not a render input.
 */
import { TIER_COST } from "./decay-curve";
/** Default history budget when a caller doesn't supply one. */
export declare const DEFAULT_HISTORY_BUDGET_TOKENS = 60000;
/** Minimal compartment shape the renderer needs (subset of Compartment). */
export interface DecayRenderCompartment {
    startMessage: number;
    endMessage: number;
    title: string;
    content: string;
    startDate?: string | null;
    endDate?: string | null;
    p1?: string | null;
    p2?: string | null;
    p3?: string | null;
    p4?: string | null;
    importance?: number | null;
    legacy?: number | null;
}
/**
 * Render a single compartment at an explicit tier. Exposed for the m[1]
 * "new compartments" block, which always renders newest compartments at P1
 * (full fidelity — no decay applies to brand-new deltas).
 */
export declare function renderCompartmentAtTier(c: DecayRenderCompartment, tier: number): string;
/**
 * Render the decayed compartment history block. Optionally prefixes a memory
 * block. Never renders session facts (v2 faithful). Returns the joined body
 * (no <session-history> wrapper — callers add their own framing).
 */
export declare function renderDecayedCompartments(args: {
    compartments: DecayRenderCompartment[];
    historyBudgetTokens: number;
}): string;
/**
 * Extract a top-level m[0] block slice (e.g. "session-history", "project-docs",
 * "user-profile") for budget measurement and token attribution. Returns the
 * full `<tag>…</tag>` slice or null. `tag` must be a literal block name (the
 * caller controls it), so the constructed RegExp is safe.
 *
 * Shared so the materialize tightening loop measures ONLY the session-history
 * slice against the history budget (not the whole m[0], which also carries
 * project-docs / user-profile / project-memory — those have their own budgets),
 * and so the sidebar/status token attribution reads the same slices both
 * harnesses actually render.
 */
export declare function extractM0Block(m0Text: string, tag: string): string | null;
export { TIER_COST };
//# sourceMappingURL=decay-render.d.ts.map