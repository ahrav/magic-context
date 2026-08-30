// Canonical commit-detection patterns — the SINGLE source of truth shared by:
//   - the historian commit-cluster trigger + summary hash extraction
//     (read-session-formatting.ts),
//   - the OpenCode note-nudge `commit_detected` boundary (tag-messages.ts),
//   - the Pi note-nudge detector (detect-recent-commit.ts).
//
// Keeping the patterns here stops drift between the three sites: change them
// once and every site follows.
//
// All three sites look for a short git hash AND a commit-related word in the
// SAME assistant text part — the pairing is what keeps false positives low.

/** A short git hash: 7-12 hex chars (git's default abbreviated hash is 7).
 *  6 was too loose — more random-hex false positives. */
const HASH_HEX = "[0-9a-f]{7,12}";

/**
 * Boolean hash test. Non-global (stateless), so this single instance is safe to
 * reuse with `.test()` across call sites — only `/g` regexes carry `lastIndex`.
 */
export const COMMIT_HASH_TEST_PATTERN = new RegExp(`\\b${HASH_HEX}\\b`, "i");

/**
 * Commit-ACTION verbs, with common inflections, each fully word-boundary-anchored
 * (so they don't match e.g. "commitment"/"merger"). Non-global → safe to share.
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

/** True when a text part mentions a commit hash in a commit context. Used by the
 *  OpenCode + Pi note-nudge detectors. */
export function textMentionsRecentCommit(text: string): boolean {
    return COMMIT_HASH_TEST_PATTERN.test(text) && COMMIT_VERB_PATTERN.test(text);
}

/**
 * Fresh `/g` capturing, backtick-aware hash pattern for the historian's
 * extract-and-strip path (matchAll + replace). Returned as a NEW instance per
 * call: a `/g` regex carries `lastIndex`, so handing out a fresh one is
 * bulletproof against accidental `.exec()` reuse across callers.
 */
export function createCommitHashExtractPattern(): RegExp {
    return new RegExp(`\`?\\b(${HASH_HEX})\\b\`?`, "gi");
}
