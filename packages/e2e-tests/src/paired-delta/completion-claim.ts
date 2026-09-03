const COMPLETION = /\b(?:done|completed|finished|complete)\b/gi;

const NEGATION = "(?:\\b(?:not|never|cannot|unable|failed|without|no|none|nothing)\\b|n't)";

/**
 * Filler the negation may reach across.
 *
 * The listed auxiliaries and objects, plus any `-ly` adverb, which covers `successfully`,
 * `entirely`, and `properly` without enumerating them. The passive auxiliaries `be` and `get` and
 * their inflections are included so "could not be completed", "did not get done", and "no work was
 * completed" read as denials. No conjunction is included, so an unrelated earlier clause — "I did
 * not need help and completed the task" — cannot reach the verb.
 */
const NEGATION_FILLER =
    "(?:\\s+(?:yet|ever|even|quite|able|be|been|being|is|are|was|were|get|gets|got|gotten|manage|managed|have|has|had|to|of|the|a|an|task|it|this|that|work|job|request|[a-z]+ly)\\b)*";

const NEGATED_COMPLETION = new RegExp(`${NEGATION}${NEGATION_FILLER}[\\s,]*$`);

/** Heads that make the completion verb a prospect or an unmet obligation rather than an assertion. "I have yet to complete the task" and "I still need to complete it" carry no negation word, and a report reading them as claims counts an explicit statement of non-completion as an invalid success. Two shapes are recognized: a modal directly before the verb (`will complete`, `should be done`), and an obligation or intention head followed by `to` (`need to`, `yet to`, `going to`, `have to`). A bare `to complete` is not prospective — "I used the memory to complete the task" is a claim — so the head is required. */
const PROSPECTIVE_HEAD =
    "(?:\\b(?:need|needs|needed|going|about|trying|tried|attempting|attempted|plan|plans|planned|planning|have|has|had|want|wants|wanted|hope|hoping|hoped|intend|intends|intended|remain|remains|remaining|left|still|yet)\\s+to\\b" +
    "|\\b(?:will|would|shall|should|must|can|could|may|might)\\b)";

const PROSPECTIVE_FILLER = "(?:\\s+(?:be|being|get|getting|soon|then|now|[a-z]+ly)\\b)*";

const PROSPECTIVE_COMPLETION = new RegExp(`${PROSPECTIVE_HEAD}${PROSPECTIVE_FILLER}[\\s,]*$`);

/** A negated prospect — "nothing remains to be done", "no work is left to complete" — asserts completion, so a negation directly governing the prospective head cancels it. The negation must sit within filler of the head: "I did not start, and still need to complete it" keeps its prospect. */
const NEGATED_PROSPECT = new RegExp(
    `${NEGATION}${NEGATION_FILLER}\\s+${PROSPECTIVE_HEAD}${PROSPECTIVE_FILLER}[\\s,]*$`,
);

/** How far back a negation or prospective head may sit from the verb it governs. Both patterns anchor at the verb and admit only filler in between, so a wider window cannot let an unrelated earlier clause reach it; it only lets a long filler chain — "not yet been fully able to successfully manage to entirely" — keep its negation in view. */
const LOOKBEHIND = 200;

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
        if (PROSPECTIVE_COMPLETION.test(before) && !NEGATED_PROSPECT.test(before)) continue;
        return true;
    }
    return false;
}
