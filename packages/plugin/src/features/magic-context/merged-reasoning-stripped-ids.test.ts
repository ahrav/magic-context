/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "../../shared/sqlite";
import {
    addMergedReasoningStrippedIds,
    addTrailingBlankDecisions,
    getMergedReasoningStrippedIds,
    getTrailingBlankDecisions,
} from "./storage-meta-persisted";
import { clearSession } from "./storage-meta-session";
import { createDirectTestDatabase } from "./test-database";

describe("merged_reasoning_stripped_ids", () => {
    let db: Database;
    const sessionId = "ses-merged-reasoning";

    beforeEach(() => {
        db = createDirectTestDatabase().db;
    });

    afterEach(() => {
        db.close();
    });

    it("persists a monotonic union of assistant message ids", () => {
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set());

        expect(addMergedReasoningStrippedIds(db, sessionId, ["assistant-1"])).toBe(true);
        expect(addMergedReasoningStrippedIds(db, sessionId, ["assistant-1", "assistant-2"])).toBe(
            true,
        );

        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(
            new Set(["assistant-1", "assistant-2"]),
        );
    });

    it("removes the applied set when the session is cleared", () => {
        addMergedReasoningStrippedIds(db, sessionId, ["assistant-1"]);
        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set(["assistant-1"]));

        clearSession(db, sessionId);

        expect(getMergedReasoningStrippedIds(db, sessionId)).toEqual(new Set());
        expect(
            db.prepare("SELECT 1 FROM session_meta WHERE session_id = ?").get(sessionId),
        ).toBeNull();
    });
});

describe("trailing_blank_decisions", () => {
    let db: Database;
    const sessionId = "ses-trailing-blank";

    beforeEach(() => {
        db = createDirectTestDatabase().db;
    });

    afterEach(() => {
        db.close();
    });

    it("persists immutable keep and strip choices", () => {
        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(new Map());
        expect(
            addTrailingBlankDecisions(db, sessionId, [
                ["assistant-keep", "keep"],
                ["assistant-strip", "strip"],
            ]),
        ).toBe(true);
        expect(addTrailingBlankDecisions(db, sessionId, [["assistant-keep", "strip"]])).toBe(true);

        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(
            new Map([
                ["assistant-keep", "keep"],
                ["assistant-strip", "strip"],
            ]),
        );
    });

    it("refreshes only the explicitly live newest assistant", () => {
        addTrailingBlankDecisions(db, sessionId, [
            ["assistant-historical", "strip"],
            ["assistant-newest", "strip"],
        ]);

        expect(
            addTrailingBlankDecisions(
                db,
                sessionId,
                [
                    ["assistant-historical", "keep"],
                    ["assistant-newest", "keep"],
                ],
                { overwriteMessageId: "assistant-newest" },
            ),
        ).toBe(true);
        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(
            new Map([
                ["assistant-historical", "strip"],
                ["assistant-newest", "keep"],
            ]),
        );
    });

    it("removes decisions when the session is cleared", () => {
        addTrailingBlankDecisions(db, sessionId, [["assistant-keep", "keep"]]);
        clearSession(db, sessionId);
        expect(getTrailingBlankDecisions(db, sessionId)).toEqual(new Map());
    });
});
