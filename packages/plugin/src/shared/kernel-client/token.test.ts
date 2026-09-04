import { describe, expect, test } from "bun:test";
import { TokenCache } from "./token";
import type { ReadRow } from "./wire";

function row(objectId: string, knownAsOf: number): ReadRow {
    return {
        object: {
            object_id: objectId,
            object_kind: "decision",
            domain_id: "memory",
            source_kind: "assistant",
            source_id: "lineage",
            source_revision: 1,
            created_commit_seq: 1,
            invalidated_commit_seq: null,
            superseded_by: null,
            sensitivity: "normal",
        },
        visibility: "visible",
        labeled: false,
        scope_id: "project:x",
        token: { object_id: objectId, known_as_of: knownAsOf },
    };
}

describe("TokenCache", () => {
    test("tokens are keyed by project and object", () => {
        const cache = new TokenCache();
        cache.remember("/a", [row("o1", 5)], 5);
        expect(cache.get("/a", "o1")).toEqual({ object_id: "o1", known_as_of: 5 });
        expect(cache.get("/b", "o1")).toBeUndefined();
        expect(cache.knownAsOfFor("/a")).toBe(5);
    });

    test("a token never moves backwards", () => {
        const cache = new TokenCache();
        cache.remember("/a", [row("o1", 9)], 9);
        cache.remember("/a", [row("o1", 4)], 4);
        expect(cache.get("/a", "o1")?.known_as_of).toBe(9);
        expect(cache.knownAsOfFor("/a")).toBe(9);
    });

    test("dropProject removes only that project", () => {
        const cache = new TokenCache();
        cache.remember("/a", [row("o1", 1)], 1);
        cache.remember("/b", [row("o2", 2)], 2);
        cache.dropProject("/a");
        expect(cache.get("/a", "o1")).toBeUndefined();
        expect(cache.knownAsOfFor("/a")).toBeUndefined();
        expect(cache.get("/b", "o2")?.known_as_of).toBe(2);
    });

    test("commit receipts mint tokens at the commit sequence", () => {
        const cache = new TokenCache();
        cache.rememberTokens("/a", [{ object_id: "o1", known_as_of: 12 }], 12);
        expect(cache.get("/a", "o1")?.known_as_of).toBe(12);
    });
});
