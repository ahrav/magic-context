/**
 * Boolean hash test. Non-global (stateless), so this single instance is safe to
 * reuse with `.test()` across call sites — only `/g` regexes carry `lastIndex`.
 */
export declare const COMMIT_HASH_TEST_PATTERN: RegExp;
/**
 * Commit-ACTION verbs, with common inflections, each fully word-boundary-anchored
 * (so they don't match e.g. "commitment"/"merger"). Non-global → safe to share.
 *
 * Scope decision: this is the commit-action set the OpenCode + Pi note-nudge
 * detectors used and pin in tests ("commit/cherry-pick/merge/rebase"). It does
 * NOT include the bare nouns "hash"/"sha" that the historian's old hint regex
 * carried — a parity test asserts "hash <hex>" alone must NOT count as a commit,
 * and those nouns only ever gated a cosmetic hash-strip in historian summaries
 * (never a trigger), so unifying to the action set is behavior-preserving where
 * it matters.
 */
export declare const COMMIT_VERB_PATTERN: RegExp;
/** True when a text part mentions a commit hash in a commit context. Used by the
 *  OpenCode + Pi note-nudge detectors. */
export declare function textMentionsRecentCommit(text: string): boolean;
/**
 * Fresh `/g` capturing, backtick-aware hash pattern for the historian's
 * extract-and-strip path (matchAll + replace). Returned as a NEW instance per
 * call: a `/g` regex carries `lastIndex`, so handing out a fresh one is
 * bulletproof against accidental `.exec()` reuse across callers.
 */
export declare function createCommitHashExtractPattern(): RegExp;
//# sourceMappingURL=commit-detection.d.ts.map