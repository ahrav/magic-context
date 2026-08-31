//     (read-session-formatting.ts),
//
//

/**
 * */
const HASH_HEX = "[0-9a-f]{7,12}";

/**
 * `COMMIT_HASH_TEST_PATTERN` omits stateful flags, so repeated `.test()` calls do not depend on prior matches.
 */
export const COMMIT_HASH_TEST_PATTERN = new RegExp(`\\b${HASH_HEX}\\b`, "i");

/**
 * Word boundaries exclude substrings such as `commitment` and `merger`.
 *
 * Only `commit`, `cherry-pick`, `merge`, and `rebase` establish commit context.
 * Bare `hash` and `sha` do not establish commit context.
 * `hash <hex>` alone does not establish commit context.
 * it matters.
 */
export const COMMIT_VERB_PATTERN =
    /\b(?:commit(?:ted|ting|s)?|cherry-?pick(?:ed|ing|s)?|merge[ds]?|merging|rebas(?:e|ed|es|ing))\b/i;

/**
 * */
export function textMentionsRecentCommit(text: string): boolean {
    return COMMIT_HASH_TEST_PATTERN.test(text) && COMMIT_VERB_PATTERN.test(text);
}

/**
 * `createCommitHashExtractPattern` returns a new global regex so callers do not share `lastIndex`.
 */
export function createCommitHashExtractPattern(): RegExp {
    return new RegExp(`\`?\\b(${HASH_HEX})\\b\`?`, "gi");
}
