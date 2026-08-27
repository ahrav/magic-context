import { cueBudgetFor } from "./compress-cues-prompt";

/**
 * Per-cue validation, applied ON WRITE (not at parse time). The compress-cues
 * host validates each cue independently; an initial failure leaves a NULL cue for
 * the next run, while the durable rejection latch eventually writes a fallback
 * rather than rejecting the whole chunk for one bad cue. This is the per-cue half
 * of the retired validateMuralManifest; manifest-level checks for duplicate ids and
 * room/merge targets are gone with the author flow.
 */

export interface CueValidationFailure {
    reason: string;
}

function hasBalancedParentheses(cue: string): boolean {
    let depth = 0;
    for (const character of cue) {
        if (character === "(") depth++;
        if (character === ")") depth--;
        if (depth < 0) return false;
    }
    return depth === 0;
}

/**
 * Validate a single compressed cue against the grammar the renderer and the
 * prompt agree on. Returns null when the cue is acceptable, or a failure with a
 * short machine-loggable reason. The `importance` selects the budget.
 *
 * Rules enforced (all independent of other cues):
 *  - non-empty after trim
 *  - within the per-importance character budget
 *  - no leaked source id matching this memory's own claim id
 *  - balanced parentheses (prohibition mechanisms use them)
 *  - a prohibition trigger word requires a ⊘ polarity marker
 *  - every ⊘ marker needs a parenthesized mechanism
 */
export function validateCue(
    cue: string,
    importance: number,
    ownId?: string,
): CueValidationFailure | null {
    const trimmed = cue.trim();
    if (trimmed.length === 0) return { reason: "empty" };

    const budget = cueBudgetFor(importance);
    const length = [...trimmed].length;
    if (length > budget) return { reason: `over-budget ${length}>${budget}` };

    // Other identifiers are legitimate memory content. Only the id shown
    // beside this memory in the prompt is a leak.
    if (ownId !== undefined && ownId.length > 0 && trimmed.includes(ownId)) {
        return { reason: "leaked-id" };
    }

    if (!hasBalancedParentheses(trimmed)) return { reason: "unbalanced-parens" };

    const markers = trimmed.split("⊘").length - 1;
    const mechanisms = trimmed.match(/\([^()]+\)/g)?.length ?? 0;
    const trigger = /\b(?:must not|never|without|instead of|exclude|excludes)\b/i.test(trimmed);
    if (trigger && markers === 0) return { reason: "prohibition-missing-marker" };
    if (markers > mechanisms) return { reason: "polarity-missing-mechanism" };

    return null;
}
