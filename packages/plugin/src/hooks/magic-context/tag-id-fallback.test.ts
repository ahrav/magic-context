/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { getTagsBySession } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { createDirectTestDatabase } from "../../features/magic-context/test-database";
import type { Database as DatabaseType } from "../../shared/sqlite";
import { type MessageLike, tagMessages } from "./transform-operations";

type TestPart = { type: "text"; text: string } | { type: "metadata"; value?: string };

function openTestDb(): DatabaseType {
    const db = createDirectTestDatabase().db;
    return db;
}

function message(id: string, parts: TestPart[]): MessageLike {
    return {
        info: { id, role: "user", sessionID: "ses-fallback" },
        parts,
    } as unknown as MessageLike;
}

function textAt(messages: MessageLike[], messageIndex: number, partIndex: number): string {
    const part = messages[messageIndex]?.parts[partIndex] as { text?: string } | undefined;
    return part?.text ?? "";
}

describe("OpenCode tag id fallback adoption", () => {
    it("unbinds the old content id so a data_version-only cache hit cannot reuse a stale alias", () => {
        const db = openTestDb();
        const sessionId = "ses-fallback";
        const tagger = createTagger();

        // Pass 1: OpenCode exposes the text at part index 1, so the tag is keyed
        // as m-stable:p1. initFromDb records the pre-write data_version signature.
        tagger.initFromDb(sessionId, db);
        const pass1 = [
            message("m-stable", [{ type: "metadata" }, { type: "text", text: "alpha" }]),
        ];
        tagMessages(sessionId, pass1, tagger, db);
        expect(textAt(pass1, 0, 1)).toBe("§1§ alpha");
        expect(tagger.getTag(sessionId, "m-stable:p1", "message")).toBe(1);

        // Pass 2: the same message is now exposed at part index 0. The fallback
        // resolver migrates tag 1 from m-stable:p1 to m-stable:p0 and must drop
        // the old in-memory alias because initFromDb now cache-hits on data_version.
        tagger.initFromDb(sessionId, db);
        const pass2 = [message("m-stable", [{ type: "text", text: "alpha" }])];
        tagMessages(sessionId, pass2, tagger, db);
        expect(textAt(pass2, 0, 0)).toBe("§1§ alpha");
        expect(tagger.getTag(sessionId, "m-stable:p0", "message")).toBe(1);
        expect(tagger.getTag(sessionId, "m-stable:p1", "message")).toBeUndefined();

        // Pass 3: m-stable:p1 is a real new text part. With the stale alias still
        // present this would incorrectly reuse §1§; with unbind+data_version-only
        // caching it allocates §2§ while preserving the migrated §1§ prefix.
        tagger.initFromDb(sessionId, db);
        const pass3 = [
            message("m-stable", [
                { type: "text", text: "alpha" },
                { type: "text", text: "beta" },
            ]),
        ];
        tagMessages(sessionId, pass3, tagger, db);

        expect(textAt(pass3, 0, 0)).toBe("§1§ alpha");
        expect(textAt(pass3, 0, 1)).toBe("§2§ beta");
        expect(
            getTagsBySession(db, sessionId).map((tag) => ({
                tagNumber: tag.tagNumber,
                messageId: tag.messageId,
            })),
        ).toEqual([
            { tagNumber: 1, messageId: "m-stable:p0" },
            { tagNumber: 2, messageId: "m-stable:p1" },
        ]);
    });

    it("cold initFromDb reload preserves byte-identical tag prefixes after restart", () => {
        const db = openTestDb();
        const sessionId = "ses-cold-restart";
        const tagger = createTagger();

        tagger.initFromDb(sessionId, db);
        const firstPass = [
            message("m-one", [{ type: "text", text: "one" }]),
            message("m-two", [{ type: "text", text: "two" }]),
        ];
        tagMessages(sessionId, firstPass, tagger, db);
        expect(firstPass.map((msg) => (msg.parts[0] as { text: string }).text)).toEqual([
            "§1§ one",
            "§2§ two",
        ]);

        const restarted = createTagger();
        restarted.initFromDb(sessionId, db);
        const replayPass = [
            message("m-one", [{ type: "text", text: "one" }]),
            message("m-two", [{ type: "text", text: "two" }]),
        ];
        tagMessages(sessionId, replayPass, restarted, db);

        expect(replayPass.map((msg) => (msg.parts[0] as { text: string }).text)).toEqual([
            "§1§ one",
            "§2§ two",
        ]);
        expect(restarted.assignTag(sessionId, "m-three:p0", "message", 3, db)).toBe(3);
    });
});
