/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    COMMIT_HASH_TEST_PATTERN,
    COMMIT_VERB_PATTERN,
    createCommitHashExtractPattern,
    textMentionsRecentCommit,
} from "./commit-detection";

describe("textMentionsRecentCommit", () => {
    it("fires on a hash + commit-action verb in the same text", () => {
        expect(textMentionsRecentCommit("Committed abc1234 with the fix")).toBe(true);
        expect(textMentionsRecentCommit("merged a1b2c3d into main")).toBe(true);
        expect(textMentionsRecentCommit("rebased onto feedb4d cleanly")).toBe(true);
        expect(textMentionsRecentCommit("cherry-picked deadbeef")).toBe(true);
    });

    it("does NOT fire on a hash alone, or the bare word 'hash'/'sha' + hex", () => {
        expect(textMentionsRecentCommit("the value is abc1234")).toBe(false);
        // 'hash' and 'sha' do not count as commit-action verbs.
        expect(textMentionsRecentCommit("hash is abc1234567")).toBe(false);
        expect(textMentionsRecentCommit("sha abc1234")).toBe(false);
    });

    it("does NOT fire on a verb alone (no hash)", () => {
        expect(textMentionsRecentCommit("I will commit later")).toBe(false);
    });

    it("respects the 7-12 hex length bound", () => {
        expect(textMentionsRecentCommit("committed abc12")).toBe(false); // too short
        expect(textMentionsRecentCommit("committed abc1234567890abcdef")).toBe(false); // too long
    });

    it("does not match commit-ish words that are not commit actions", () => {
        expect(COMMIT_VERB_PATTERN.test("commitment to abc1234")).toBe(false);
        expect(COMMIT_VERB_PATTERN.test("a merger of abc1234")).toBe(false);
    });
});

describe("shared regex instances are stateless across calls", () => {
    it("COMMIT_HASH_TEST_PATTERN.test is repeatable (non-global)", () => {
        expect(COMMIT_HASH_TEST_PATTERN.test("abc1234")).toBe(true);
        expect(COMMIT_HASH_TEST_PATTERN.test("abc1234")).toBe(true); // no lastIndex drift
    });

    it("createCommitHashExtractPattern returns a fresh global regex each call", () => {
        const a = createCommitHashExtractPattern();
        const b = createCommitHashExtractPattern();
        expect(a).not.toBe(b);
        expect(a.global).toBe(true);
    });
});

describe("createCommitHashExtractPattern (historian extraction)", () => {
    it("captures backtick-wrapped and bare hashes, deduped via matchAll", () => {
        const text = "Committed `abc1234` and def5678, also abc1234 again";
        const found = [...text.matchAll(createCommitHashExtractPattern())].map((m) =>
            m[1]?.toLowerCase(),
        );
        expect(found).toEqual(["abc1234", "def5678", "abc1234"]);
    });
});
