//     (read-session-formatting.ts),
//
// Keeping the patterns here stops drift between the three sites: change them
// once and every site follows.
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
 * Scope decision: this is the commit-action set the OpenCode + Pi note-nudge
 * detectors used and pin in tests ("commit/cherry-pick/merge/rebase"). It does
 * NOT include the bare nouns "hash"/"sha" — a parity test asserts
 * "hash <hex>" alone must NOT count as a commit,
 * and those nouns only ever gated a cosmetic hash-strip in historian summaries
 * (never a trigger), so unifying to the action set is behavior-preserving where
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
