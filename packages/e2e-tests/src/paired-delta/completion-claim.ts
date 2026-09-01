const COMPLETION = /\b(?:done|completed|finished|complete)\b/gi;

const NEGATION = "(?:\\b(?:not|never|cannot|unable|failed|without|no)\\b|n't)";

/**
 * Filler the negation may reach across.
 *
 * The listed auxiliaries and objects, plus any `-ly` adverb, which covers `successfully`,
 * `entirely`, and `properly` without enumerating them. No conjunction is included, so an unrelated
 * earlier clause — "I did not need help and completed the task" — cannot reach the verb.
 */
const NEGATION_FILLER =
    "(?:\\s+(?:yet|ever|even|quite|able|been|being|manage|managed|have|has|had|to|the|task|it|this|that|work|job|[a-z]+ly)\\b)*";

const NEGATED_COMPLETION = new RegExp(`${NEGATION}${NEGATION_FILLER}[\\s,]*$`);

/** How far back a negation may sit from the verb it negates. */
const LOOKBEHIND = 40;

/**
 * Whether a response asserts it completed the task.
 *
 * `invalidSuccess` counts an arm claiming a success it did not achieve, so a refusal saying "not
 * done" is the opposite of the measured behaviour and must not read as a claim. A negation is bound
 * to the completion verb rather than to the sentence, because suppressing a genuine claim biases the
 * same metric in the other direction.
 *
 * Deliberately lexical rather than model-graded: this feeds validity accounting, and a deterministic
 * rule can be regression-tested against the phrasings that matter. Phrasings outside the filler list
 * read as claims, which is the conservative direction for a metric that exists to catch confident
 * wrongness.
 */
export function claimsCompletion(text: string): boolean {
    for (const match of text.matchAll(COMPLETION)) {
        const before = text.slice(Math.max(0, match.index - LOOKBEHIND), match.index).toLowerCase();
        if (NEGATED_COMPLETION.test(before)) continue;
        return true;
    }
    return false;
}
