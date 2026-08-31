/**
 *
 * Focus areas:
 * The cleanup assigns tiers by 20/20/20/40 age buckets.
 * The cleanup considers only active message tags outside the protected tail.
 * minChars excludes texts shorter than its value.
 *  - Repeated tier shifts compress from ORIGINAL, never from cavemaned text
 * `tags.caveman_depth` lets later passes skip tags already at their target depth.
 */

import { describe, expect, test } from "bun:test";
import {
    getTagsBySession,
    insertTag,
    saveSourceContent,
} from "../../features/magic-context/storage";
import type { openDatabase } from "../../features/magic-context/storage-db";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import { cavemanCompress } from "./caveman";
import {
    applyCavemanCleanup,
    computeTargetDepth,
    replayCavemanCompression,
} from "./caveman-cleanup";
import type { TagTarget } from "./tag-messages";

const SESSION = "ses-caveman-test";

function createInMemoryDb(): ReturnType<typeof openDatabase> {
    const db = createDirectTestDatabase().db as ReturnType<typeof openDatabase>;
    return db;
}

function mockTarget(initialContent: string): {
    target: TagTarget;
    getContent(): string;
} {
    let content = initialContent;
    const target: TagTarget = {
        setContent: (newContent) => {
            if (content === newContent) return false;
            content = newContent;
            return true;
        },
        getContent: () => content,
    };
    return {
        target,
        getContent: () => content,
    };
}

describe("computeTargetDepth", () => {
    test("empty eligible list returns 0", () => {
        expect(computeTargetDepth(0, 0)).toBe(0);
    });

    test("20/20/20/40 boundaries for 10 items", () => {
        expect(computeTargetDepth(0, 10)).toBe(3); // ultra
        expect(computeTargetDepth(1, 10)).toBe(3); // ultra
        expect(computeTargetDepth(2, 10)).toBe(2); // full
        expect(computeTargetDepth(3, 10)).toBe(2); // full
        expect(computeTargetDepth(4, 10)).toBe(1); // lite
        expect(computeTargetDepth(5, 10)).toBe(1); // lite
        expect(computeTargetDepth(6, 10)).toBe(0);
        expect(computeTargetDepth(9, 10)).toBe(0);
    });

    test("rounding: 5-item split, newest still untouched", () => {
        expect(computeTargetDepth(0, 5)).toBe(3);
        expect(computeTargetDepth(1, 5)).toBe(2);
        expect(computeTargetDepth(2, 5)).toBe(1);
        expect(computeTargetDepth(3, 5)).toBe(0);
        expect(computeTargetDepth(4, 5)).toBe(0);
    });
});

describe("applyCavemanCleanup", () => {
    test("no-op when disabled", () => {
        const db = createInMemoryDb();
        const result = applyCavemanCleanup(SESSION, db, new Map(), [], {
            enabled: false,
            minChars: 500,
            protectedTags: 10,
        });
        expect(result).toEqual({
            compressedToLite: 0,
            compressedToFull: 0,
            compressedToUltra: 0,
            mutatedTextTags: 0,
        });
    });

    test("no-op when no eligible tags", () => {
        const db = createInMemoryDb();
        // Only tool tags — caveman skips them
        insertTag(db, SESSION, "msg-1", "tool", 5000, 1);
        const tags = getTagsBySession(db, SESSION);
        const result = applyCavemanCleanup(SESSION, db, new Map(), tags, {
            enabled: true,
            minChars: 100,
            protectedTags: 0,
        });
        expect(result.compressedToLite + result.compressedToFull + result.compressedToUltra).toBe(
            0,
        );
    });

    test("compresses oldest message tag to ultra", () => {
        const db = createInMemoryDb();
        const longText =
            "I just wanted to basically clearly explain that the implementation is actually really quite complex, and in order to understand it, we need to consider that historian and compartment and compressor work together; because of that, furthermore the agent additionally must realize the concept.";
        for (let i = 1; i <= 10; i++) {
            insertTag(db, SESSION, `msg-${i}`, "message", longText.length * 2, i);
            saveSourceContent(db, SESSION, i, longText);
        }
        const tags = getTagsBySession(db, SESSION);
        const targets = new Map<number, TagTarget>();
        const controllers: Array<{ get: () => string; tagNumber: number }> = [];
        for (const tag of tags) {
            const { target, getContent } = mockTarget(longText);
            targets.set(tag.tagNumber, target);
            controllers.push({ get: getContent, tagNumber: tag.tagNumber });
        }

        const result = applyCavemanCleanup(SESSION, db, targets, tags, {
            enabled: true,
            minChars: 50,
            protectedTags: 0,
        });

        expect(result.compressedToUltra).toBe(2); // positions 0,1 -> ultra (20% of 10)
        expect(result.compressedToFull).toBe(2); // positions 2,3 -> full
        expect(result.compressedToLite).toBe(2); // positions 4,5 -> lite
        const oldestContent = controllers.find((c) => c.tagNumber === 1)!.get();
        const youngestContent = controllers.find((c) => c.tagNumber === 10)!.get();
        expect(oldestContent).not.toBe(longText); // cavemaned
        expect(youngestContent).toBe(longText); // untouched
        expect(oldestContent.length).toBeLessThan(longText.length); // shorter
    });

    test("skips tags shorter than min_chars", () => {
        const db = createInMemoryDb();
        const shortText = "brief";
        const longText = "I just really basically wanted to clearly explain ".repeat(10);
        insertTag(db, SESSION, "msg-1", "message", shortText.length, 1);
        saveSourceContent(db, SESSION, 1, shortText);
        insertTag(db, SESSION, "msg-2", "message", longText.length, 2);
        saveSourceContent(db, SESSION, 2, longText);

        const tags = getTagsBySession(db, SESSION);
        const targets = new Map<number, TagTarget>();
        for (const tag of tags) {
            const text = tag.tagNumber === 1 ? shortText : longText;
            targets.set(tag.tagNumber, mockTarget(text).target);
        }

        const result = applyCavemanCleanup(SESSION, db, targets, tags, {
            enabled: true,
            minChars: 100,
            protectedTags: 0,
        });

        expect(result.compressedToUltra).toBe(1);
    });

    test("respects protected tail", () => {
        const db = createInMemoryDb();
        const longText = "I just really basically wanted to clearly explain ".repeat(10);
        for (let i = 1; i <= 5; i++) {
            insertTag(db, SESSION, `msg-${i}`, "message", longText.length, i);
            saveSourceContent(db, SESSION, i, longText);
        }

        const tags = getTagsBySession(db, SESSION);
        const targets = new Map<number, TagTarget>();
        for (const tag of tags) {
            targets.set(tag.tagNumber, mockTarget(longText).target);
        }

        const result = applyCavemanCleanup(SESSION, db, targets, tags, {
            enabled: true,
            minChars: 50,
            protectedTags: 3,
        });

        expect(result.compressedToUltra).toBe(1);
        expect(result.compressedToLite).toBe(1);
    });

    test("re-compresses from original source, not from cavemaned intermediate", () => {
        const db = createInMemoryDb();
        const longText = "I just really basically wanted to clearly explain ".repeat(20);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        saveSourceContent(db, SESSION, 1, longText);

        const tags = getTagsBySession(db, SESSION);
        const { target, getContent } = mockTarget(longText);
        const targets = new Map<number, TagTarget>([[1, target]]);

        applyCavemanCleanup(SESSION, db, targets, tags, {
            enabled: true,
            minChars: 50,
            protectedTags: 0,
        });
        const afterUltra = getContent();
        expect(afterUltra).not.toBe(longText);
        const afterPass1Tags = getTagsBySession(db, SESSION);
        expect(afterPass1Tags[0].cavemanDepth).toBe(3);

        // The second pass does not mutate the tag because cavemanDepth already meets or exceeds the target.
        const result = applyCavemanCleanup(SESSION, db, targets, afterPass1Tags, {
            enabled: true,
            minChars: 50,
            protectedTags: 0,
        });
        expect(result.compressedToLite + result.compressedToFull + result.compressedToUltra).toBe(
            0,
        );
        expect(getContent()).toBe(afterUltra); // unchanged
    });

    test("handles missing source content gracefully (skip, no crash)", () => {
        const db = createInMemoryDb();
        const longText = "a".repeat(500);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);

        const tags = getTagsBySession(db, SESSION);
        const targets = new Map<number, TagTarget>([[1, mockTarget(longText).target]]);

        const result = applyCavemanCleanup(SESSION, db, targets, tags, {
            enabled: true,
            minChars: 50,
            protectedTags: 0,
        });

        expect(result.compressedToLite + result.compressedToFull + result.compressedToUltra).toBe(
            0,
        );
    });

    test("depth escalation: tier shift always compresses from original, not intermediate", () => {
        // A tag can move from lite to ultra when newer tags move it into an older tier.
        const db = createInMemoryDb();
        const longText = "I just really basically wanted to clearly explain ".repeat(20);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        saveSourceContent(db, SESSION, 1, longText);

        const { target } = mockTarget(longText);
        const targets = new Map<number, TagTarget>([[1, target]]);

        for (let i = 2; i <= 5; i++) {
            insertTag(db, SESSION, `msg-${i}`, "message", longText.length, i);
            saveSourceContent(db, SESSION, i, longText);
            targets.set(i, mockTarget(longText).target);
        }
        const tags5 = getTagsBySession(db, SESSION);

        applyCavemanCleanup(SESSION, db, targets, tags5, {
            enabled: true,
            minChars: 50,
            protectedTags: 0,
        });

        const afterPass1 = getTagsBySession(db, SESSION);
        const tag3 = afterPass1.find((t) => t.tagNumber === 3)!;
        expect(tag3.cavemanDepth).toBe(1); // lite

        db.prepare("UPDATE tags SET caveman_depth = 0 WHERE session_id = ? AND tag_number = ?").run(
            SESSION,
            3,
        );
        const tag3TargetData = mockTarget(longText);
        targets.set(3, tag3TargetData.target);

        for (let i = 6; i <= 25; i++) {
            insertTag(db, SESSION, `msg-${i}`, "message", longText.length, i);
            saveSourceContent(db, SESSION, i, longText);
            targets.set(i, mockTarget(longText).target);
        }
        const tags25 = getTagsBySession(db, SESSION);
        applyCavemanCleanup(SESSION, db, targets, tags25, {
            enabled: true,
            minChars: 50,
            protectedTags: 0,
        });

        const expectedUltra = cavemanCompress(longText, "ultra");
        expect(tag3TargetData.getContent()).toBe(expectedUltra);
        const finalTags = getTagsBySession(db, SESSION);
        const tag3Final = finalTags.find((t) => t.tagNumber === 3)!;
        expect(tag3Final.cavemanDepth).toBe(3);
    });
});

describe("replayCavemanCompression", () => {
    test("returns 0 when no tags carry caveman_depth", () => {
        const db = createInMemoryDb();
        const longText = "a".repeat(500);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        saveSourceContent(db, SESSION, 1, longText);

        const tags = getTagsBySession(db, SESSION);
        const targets = new Map<number, TagTarget>([[1, mockTarget(longText).target]]);

        const replayed = replayCavemanCompression(SESSION, db, targets, tags);
        expect(replayed).toBe(0);
    });

    test("re-applies persisted depth on defer pass without changing depth", () => {
        // After defer restores original target text, replay must reapply the persisted ULTRA compression.
        const db = createInMemoryDb();
        const longText = "I just really basically wanted to clearly explain ".repeat(20);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        saveSourceContent(db, SESSION, 1, longText);

        db.prepare("UPDATE tags SET caveman_depth = 3 WHERE session_id = ? AND tag_number = ?").run(
            SESSION,
            1,
        );

        const tags = getTagsBySession(db, SESSION);
        const { target, getContent } = mockTarget(longText);
        const targets = new Map<number, TagTarget>([[1, target]]);

        const replayed = replayCavemanCompression(SESSION, db, targets, tags);

        expect(replayed).toBe(1);
        expect(getContent()).toBe(cavemanCompress(longText, "ultra"));
        // replayCavemanCompression must not update cavemanDepth.
        const tagsAfter = getTagsBySession(db, SESSION);
        expect(tagsAfter[0].cavemanDepth).toBe(3);
    });

    test("idempotent: running replay twice produces the same result", () => {
        const db = createInMemoryDb();
        const longText = "I just really basically wanted to clearly explain ".repeat(20);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        saveSourceContent(db, SESSION, 1, longText);
        db.prepare("UPDATE tags SET caveman_depth = 2 WHERE session_id = ? AND tag_number = ?").run(
            SESSION,
            1,
        );

        const tagsForReplay = getTagsBySession(db, SESSION);
        const { target, getContent } = mockTarget(longText);
        const targets = new Map<number, TagTarget>([[1, target]]);

        replayCavemanCompression(SESSION, db, targets, tagsForReplay);
        const after1 = getContent();

        const replayed = replayCavemanCompression(SESSION, db, targets, tagsForReplay);
        expect(replayed).toBe(0);
        expect(getContent()).toBe(after1);
    });

    test("skips tags missing source content (defensive)", () => {
        const db = createInMemoryDb();
        const longText = "a".repeat(500);
        insertTag(db, SESSION, "msg-1", "message", longText.length, 1);
        db.prepare("UPDATE tags SET caveman_depth = 1 WHERE session_id = ? AND tag_number = ?").run(
            SESSION,
            1,
        );

        const tags = getTagsBySession(db, SESSION);
        const targets = new Map<number, TagTarget>([[1, mockTarget(longText).target]]);

        const replayed = replayCavemanCompression(SESSION, db, targets, tags);
        expect(replayed).toBe(0);
    });
});
