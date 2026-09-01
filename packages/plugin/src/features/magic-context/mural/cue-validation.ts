import { cueBudgetFor } from "./compress-cues-prompt";

/**
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
 *
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
